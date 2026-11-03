Vendored verbatim from trendvidia/protowire `testdata/` at 577f4cf
(`test.proto` is copied into `dataset/` and `repeated/`). To refresh, copy the
directories again, update that commit here and run `npm run gen:testdata:corpus`.

`postdecode/` is written for this port and is not from the spec repo.

`reference.json` is what protowire-go, pinned in `scripts/go-reference/go.mod`,
does with each fixture. It is generated: do not edit it.
