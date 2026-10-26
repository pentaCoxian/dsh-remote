import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/** The authoritative schema, read from `protocol/native-v1.schema.json` at the repo root. */
export const schema: { $id: string; $defs: Record<string, unknown> } = JSON.parse(
  readFileSync(new URL('../../../protocol/native-v1.schema.json', import.meta.url), 'utf8'),
);

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: false });
ajv.addSchema(schema);

export type SchemaName =
  | 'PromptRequest'
  | 'CancelRequest'
  | 'ApprovalResponseRequest'
  | 'PairRedeemRequest'
  | 'LeaseRequest'
  | 'ClientFrame'
  | 'ErrorEnvelope'
  | 'Meta'
  | 'Workspace'
  | 'SessionSummary'
  | 'SessionSnapshot'
  | 'PromptReceipt'
  | 'Approval'
  | 'PairRedeemResponse'
  | 'PairStatusResponse'
  | 'DeviceGrant'
  | 'HostAddress'
  | 'WebSession'
  | 'Lease'
  | 'ServerFrame';

const compiled = new Map<SchemaName, ValidateFunction>();

/** Validator for one `$defs` entry; compiled once. */
export function validatorFor(name: SchemaName): ValidateFunction {
  let validate = compiled.get(name);
  if (validate === undefined) {
    validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
    if (validate === undefined) throw new Error(`schema: no $defs entry ${name}`);
    compiled.set(name, validate);
  }
  return validate;
}

export function isValid(name: SchemaName, value: unknown): boolean {
  return validatorFor(name)(value);
}
