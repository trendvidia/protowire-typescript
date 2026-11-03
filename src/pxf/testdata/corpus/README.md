Vendored verbatim from trendvidia/protowire `testdata/` at 577f4cf
(`test.proto` is copied into `dataset/` and `repeated/`). To refresh, copy the
directories again, update that commit here and run `npm run gen:testdata:corpus`.

`postdecode/`, `discard/` and `bignum/` are written for this port and are not from the spec repo.
`bigfloat/` holds the `.pxf` and `.binpb` fixtures and `bigfloat.proto` from the
same commit. Only `<dir>/<dir>.binpb` is a descriptor set: `bigfloat/` has one
built like every other directory's, and its other `.binpb` files are expected
bytes. `src/pxf/bigfloat.test.ts` drives them.

`reference.json` is what protowire-go, pinned in `scripts/go-reference/go.mod`,
does with each fixture. It is generated: do not edit it.
