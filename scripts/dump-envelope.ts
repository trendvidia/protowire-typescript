// Dumps a canonical envelope's pb-encoded bytes as hex, for cross-port
// wire-compat checking. The same canonical value is constructed in the
// Go and C++ ports.

import { Envelope, EnvelopePb, newAppError } from "../src/envelope/index.js";

const ae = newAppError(
  "INSUFFICIENT_FUNDS",
  "balance too low",
  "$3.50",
  "$10.00",
)
  .withField("amount", "MIN_VALUE", "below minimum", "10.00")
  .withMeta("request_id", "req-123");

const env = new Envelope({
  status: 402,
  data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  error: ae,
});

const bytes = EnvelopePb.marshal(env);
const hex = Array.from(bytes)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
console.log(hex);
