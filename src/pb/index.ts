export { Reader, Writer, WireType } from "./wire.js";
export {
  defineMessage,
  marshal,
  unmarshal,
} from "./codec.js";
export type {
  CodecBase,
  DefineMessageOpts,
  FieldSpec,
  Kind,
  MapKeyKind,
  MessageCodec,
  ScalarKind,
} from "./codec.js";
