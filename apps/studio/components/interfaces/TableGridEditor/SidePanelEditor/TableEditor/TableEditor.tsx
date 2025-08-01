import type { PostgresTable } from '@supabase/postgres-meta'
import { isEmpty, isUndefined, noop } from 'lodash'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useProjectContext } from 'components/layouts/ProjectLayout/ProjectContext'
import { DocsButton } from 'components/ui/DocsButton'
import { useDatabasePublicationsQuery } from 'data/database-publications/database-publications-query'
import {
  CONSTRAINT_TYPE,
  Constraint,
  useTableConstraintsQuery,
} from 'data/database/constraints-query'
import {
  ForeignKeyConstraint,
  useForeignKeyConstraintsQuery,
} from 'data/database/foreign-key-constraints-query'
import { useEnumeratedTypesQuery } from 'data/enumerated-types/enumerated-types-query'
import { useSendEventMutation } from 'data/telemetry/send-event-mutation'
import { useIsFeatureEnabled } from 'hooks/misc/useIsFeatureEnabled'
import { useQuerySchemaState } from 'hooks/misc/useSchemaQueryState'
import { useSelectedOrganization } from 'hooks/misc/useSelectedOrganization'
import { useUrlState } from 'hooks/ui/useUrlState'
import { useProtectedSchemas } from 'hooks/useProtectedSchemas'
import { useTableEditorStateSnapshot } from 'state/table-editor'
import { Badge, Checkbox, Input, SidePanel } from 'ui'
import { Admonition } from 'ui-patterns'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'
import ActionBar from '../ActionBar'
import type { ForeignKey } from '../ForeignKeySelector/ForeignKeySelector.types'
import { formatForeignKeys } from '../ForeignKeySelector/ForeignKeySelector.utils'
import type { ColumnField } from '../SidePanelEditor.types'
import SpreadsheetImport from '../SpreadsheetImport/SpreadsheetImport'
import ColumnManagement from './ColumnManagement'
import { ForeignKeysManagement } from './ForeignKeysManagement/ForeignKeysManagement'
import HeaderTitle from './HeaderTitle'
import RLSDisableModalContent from './RLSDisableModal'
import { DEFAULT_COLUMNS } from './TableEditor.constants'
import type { ImportContent, TableField } from './TableEditor.types'
import {
  formatImportedContentToColumnFields,
  generateTableField,
  generateTableFieldFromPostgresTable,
  validateFields,
} from './TableEditor.utils'

export interface TableEditorProps {
  table?: PostgresTable
  isDuplicating: boolean
  visible: boolean
  closePanel: () => void
  saveChanges: (
    payload: {
      name: string
      schema: string
      comment?: string | undefined
    },
    columns: ColumnField[],
    foreignKeyRelations: ForeignKey[],
    isNewRecord: boolean,
    configuration: {
      tableId?: number
      importContent?: ImportContent
      isRLSEnabled: boolean
      isRealtimeEnabled: boolean
      isDuplicateRows: boolean
      existingForeignKeyRelations: ForeignKeyConstraint[]
      primaryKey?: Constraint
    },
    resolve: any
  ) => void
  updateEditorDirty: () => void
}

const TableEditor = ({
  table,
  isDuplicating,
  visible = false,
  closePanel = noop,
  saveChanges = noop,
  updateEditorDirty = noop,
}: TableEditorProps) => {
  const snap = useTableEditorStateSnapshot()
  const { project } = useProjectContext()
  const org = useSelectedOrganization()
  const { selectedSchema } = useQuerySchemaState()
  const isNewRecord = isUndefined(table)
  const realtimeEnabled = useIsFeatureEnabled('realtime:all')
  const { mutate: sendEvent } = useSendEventMutation()

  const [params, setParams] = useUrlState()
  useEffect(() => {
    if (params.create === 'table' && snap.ui.open === 'none') {
      snap.onAddTable()
      setParams({ ...params, create: undefined })
    }
  }, [snap, params, setParams])

  const { data: types } = useEnumeratedTypesQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })
  const { data: protectedSchemas } = useProtectedSchemas({ excludeSchemas: ['extensions'] })
  const enumTypes = (types ?? []).filter(
    (type) => !protectedSchemas.find((s) => s.name === type.schema)
  )

  const { data: publications } = useDatabasePublicationsQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })
  const realtimePublication = (publications ?? []).find(
    (publication) => publication.name === 'supabase_realtime'
  )
  const realtimeEnabledTables = realtimePublication?.tables ?? []
  const isRealtimeEnabled = isNewRecord
    ? false
    : realtimeEnabledTables.some((t: any) => t.id === table?.id)

  const [errors, setErrors] = useState<any>({})
  const [tableFields, setTableFields] = useState<TableField>()
  const [fkRelations, setFkRelations] = useState<ForeignKey[]>([])

  const [isDuplicateRows, setIsDuplicateRows] = useState<boolean>(false)
  const [importContent, setImportContent] = useState<ImportContent>()
  const [isImportingSpreadsheet, setIsImportingSpreadsheet] = useState<boolean>(false)
  const [rlsConfirmVisible, setRlsConfirmVisible] = useState<boolean>(false)

  const { data: constraints } = useTableConstraintsQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
    id: table?.id,
  })
  const primaryKey = (constraints ?? []).find(
    (constraint) => constraint.type === CONSTRAINT_TYPE.PRIMARY_KEY_CONSTRAINT
  )

  const { data: foreignKeyMeta, isSuccess: isSuccessForeignKeyMeta } =
    useForeignKeyConstraintsQuery({
      projectRef: project?.ref,
      connectionString: project?.connectionString,
      schema: table?.schema,
    })
  const foreignKeys = (foreignKeyMeta ?? []).filter(
    (fk) => fk.source_schema === table?.schema && fk.source_table === table?.name
  )

  const onUpdateField = (changes: Partial<TableField>) => {
    const updatedTableFields = { ...tableFields, ...changes } as TableField
    setTableFields(updatedTableFields)
    updateEditorDirty()

    const updatedErrors = { ...errors }
    for (const key of Object.keys(changes)) {
      delete updatedErrors[key]
    }
    setErrors(updatedErrors)
  }

  const onUpdateFkRelations = (relations: ForeignKey[]) => {
    if (tableFields === undefined) return
    const updatedColumns: ColumnField[] = []

    relations.forEach((relation) => {
      relation.columns.forEach((column) => {
        const sourceColumn = tableFields.columns.find((col) => col.name === column.source)
        if (sourceColumn?.isNewColumn && column.targetType) {
          updatedColumns.push({ ...sourceColumn, format: column.targetType })
        }
      })
    })

    if (updatedColumns.length > 0) {
      const updatedTableFields = {
        ...tableFields,
        columns: tableFields.columns.map((col) => {
          const updatedColumn = updatedColumns.find((x) => x.id === col.id)
          if (updatedColumn) return updatedColumn
          else return col
        }),
      }
      setTableFields(updatedTableFields)
    }
    setFkRelations(relations)
  }

  const onSaveChanges = (resolve: any) => {
    if (tableFields) {
      const errors: any = validateFields(tableFields)
      if (errors.columns) {
        toast.error(errors.columns)
      }
      setErrors(errors)

      if (isEmpty(errors)) {
        const payload = {
          name: tableFields.name.trim(),
          schema: selectedSchema,
          comment: tableFields.comment?.trim(),
          ...(!isNewRecord && { rls_enabled: tableFields.isRLSEnabled }),
        }
        const configuration = {
          tableId: table?.id,
          importContent,
          isRLSEnabled: tableFields.isRLSEnabled,
          isRealtimeEnabled: tableFields.isRealtimeEnabled,
          isDuplicateRows: isDuplicateRows,
          existingForeignKeyRelations: foreignKeys,
          primaryKey,
        }
        const columns = tableFields.columns.map((column) => {
          return { ...column, name: column.name.trim() }
        })

        saveChanges(payload, columns, fkRelations, isNewRecord, configuration, resolve)
      } else {
        resolve()
      }
    }
  }

  useEffect(() => {
    if (visible) {
      setErrors({})
      setImportContent(undefined)
      setIsDuplicateRows(false)
      if (isNewRecord) {
        const tableFields = generateTableField()
        setTableFields(tableFields)
        setFkRelations([])
      } else {
        const tableFields = generateTableFieldFromPostgresTable(
          table,
          foreignKeyMeta || [],
          isDuplicating,
          isRealtimeEnabled
        )
        setTableFields(tableFields)
      }
    }
  }, [visible])

  useEffect(() => {
    if (isSuccessForeignKeyMeta) setFkRelations(formatForeignKeys(foreignKeys))
  }, [isSuccessForeignKeyMeta])

  useEffect(() => {
    if (importContent && !isEmpty(importContent)) {
      const importedColumns = formatImportedContentToColumnFields(importContent)
      onUpdateField({ columns: importedColumns })
    }
  }, [importContent])

  if (!tableFields) return null

  return (
    <SidePanel
      size="large"
      key="TableEditor"
      visible={visible}
      header={<HeaderTitle schema={selectedSchema} table={table} isDuplicating={isDuplicating} />}
      className={`transition-all duration-100 ease-in ${isImportingSpreadsheet ? ' mr-32' : ''}`}
      onCancel={closePanel}
      onConfirm={() => (resolve: () => void) => onSaveChanges(resolve)}
      customFooter={
        <ActionBar
          backButtonLabel="Cancel"
          applyButtonLabel="Save"
          closePanel={closePanel}
          applyFunction={(resolve: () => void) => onSaveChanges(resolve)}
        />
      }
    >
      <SidePanel.Content className="space-y-10 py-6">
        <Input
          data-testid="table-name-input"
          label="Name"
          layout="horizontal"
          type="text"
          error={errors.name}
          value={tableFields?.name}
          onChange={(event: any) => onUpdateField({ name: event.target.value })}
        />
        <Input
          label="Description"
          placeholder="Optional"
          layout="horizontal"
          type="text"
          value={tableFields?.comment ?? ''}
          onChange={(event: any) => onUpdateField({ comment: event.target.value })}
        />
      </SidePanel.Content>
      <SidePanel.Separator />
      <SidePanel.Content className="space-y-10 py-6">
        <Checkbox
          id="enable-rls"
          // @ts-ignore
          label={
            <div className="flex items-center space-x-2">
              <span>Enable Row Level Security (RLS)</span>
              <Badge>Recommended</Badge>
            </div>
          }
          description="Restrict access to your table by enabling RLS and writing Postgres policies."
          checked={tableFields.isRLSEnabled}
          onChange={() => {
            // if isEnabled, show confirm modal to turn off
            // if not enabled, allow turning on without modal confirmation
            tableFields.isRLSEnabled
              ? setRlsConfirmVisible(true)
              : onUpdateField({ isRLSEnabled: !tableFields.isRLSEnabled })
          }}
          size="medium"
        />
        {tableFields.isRLSEnabled ? (
          <Admonition
            type="default"
            className="!mt-3"
            title="Policies are required to query data"
            description={
              <>
                You need to create an access policy before you can query data from this table.
                Without a policy, querying this table will return an{' '}
                <u className="text-foreground">empty array</u> of results.{' '}
                {isNewRecord ? 'You can create policies after saving this table.' : ''}
              </>
            }
          >
            <DocsButton
              abbrev={false}
              className="mt-2"
              href="https://supabase.com/docs/guides/auth/row-level-security"
            />
          </Admonition>
        ) : (
          <Admonition
            type="warning"
            className="!mt-3"
            title="You are allowing anonymous access to your table"
            description={
              <>
                {tableFields.name ? `The table ${tableFields.name}` : 'Your table'} will be publicly
                writable and readable
              </>
            }
          >
            <DocsButton
              abbrev={false}
              className="mt-2"
              href="https://supabase.com/docs/guides/auth/row-level-security"
            />
          </Admonition>
        )}
        {realtimeEnabled && (
          <Checkbox
            id="enable-realtime"
            label="Enable Realtime"
            description="Broadcast changes on this table to authorized subscribers"
            checked={tableFields.isRealtimeEnabled}
            onChange={() => {
              sendEvent({
                action: 'realtime_toggle_table_clicked',
                properties: {
                  newState: tableFields.isRealtimeEnabled ? 'disabled' : 'enabled',
                  origin: 'tableSidePanel',
                },
                groups: {
                  project: project?.ref ?? 'Unknown',
                  organization: org?.slug ?? 'Unknown',
                },
              })
              onUpdateField({ isRealtimeEnabled: !tableFields.isRealtimeEnabled })
            }}
            size="medium"
          />
        )}
      </SidePanel.Content>
      <SidePanel.Separator />
      <SidePanel.Content className="space-y-10 py-6">
        {!isDuplicating && (
          <ColumnManagement
            table={tableFields}
            columns={tableFields?.columns}
            relations={fkRelations}
            enumTypes={enumTypes}
            isNewRecord={isNewRecord}
            importContent={importContent}
            onColumnsUpdated={(columns) => onUpdateField({ columns })}
            onSelectImportData={() => setIsImportingSpreadsheet(true)}
            onClearImportContent={() => {
              onUpdateField({ columns: DEFAULT_COLUMNS })
              setImportContent(undefined)
            }}
            onUpdateFkRelations={onUpdateFkRelations}
          />
        )}
        {isDuplicating && (
          <>
            <Checkbox
              id="duplicate-rows"
              label="Duplicate table entries"
              description="This will copy all the data in the table into the new table"
              checked={isDuplicateRows}
              onChange={() => setIsDuplicateRows(!isDuplicateRows)}
              size="medium"
            />
          </>
        )}

        <SpreadsheetImport
          visible={isImportingSpreadsheet}
          headers={importContent?.headers}
          rows={importContent?.rows}
          saveContent={(prefillData: ImportContent) => {
            setImportContent(prefillData)
            setIsImportingSpreadsheet(false)
          }}
          closePanel={() => setIsImportingSpreadsheet(false)}
        />

        <ConfirmationModal
          visible={rlsConfirmVisible}
          title="Turn off Row Level Security"
          confirmLabel="Confirm"
          size="medium"
          onCancel={() => setRlsConfirmVisible(false)}
          onConfirm={() => {
            onUpdateField({ isRLSEnabled: !tableFields.isRLSEnabled })
            setRlsConfirmVisible(false)
          }}
        >
          <RLSDisableModalContent />
        </ConfirmationModal>
      </SidePanel.Content>

      {!isDuplicating && (
        <>
          <SidePanel.Separator />
          <SidePanel.Content className="py-6">
            <ForeignKeysManagement
              table={tableFields}
              relations={fkRelations}
              closePanel={closePanel}
              setEditorDirty={() => updateEditorDirty()}
              onUpdateFkRelations={onUpdateFkRelations}
            />
          </SidePanel.Content>
        </>
      )}
    </SidePanel>
  )
}

export default TableEditor
