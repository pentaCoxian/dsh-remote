import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { SCHEMA } from './schema-data.ts';

/** The authoritative schema, `protocol/native-v1.schema.json` at the repo root, compiled in (scripts/gen-schema.ts). */
export const schema: { $id: string; $defs: Record<string, unknown> } = SCHEMA;

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
  | 'PushRegistrationRequest'
  | 'PushStatus'
  | 'PushMessage'
  | 'GatewayHandleRequest'
  | 'GatewayHandleResponse'
  | 'GatewayPushRequest'
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
