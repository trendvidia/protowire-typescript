#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 TrendVidia, LLC.
#
# Builds one descriptor set per vendored corpus directory.
set -eu
root=src/pxf/testdata/corpus
for dir in "$root"/*/; do
  name=$(basename "$dir")
  # shellcheck disable=SC2086
  protoc --include_imports --descriptor_set_out="$root/$name/$name.binpb" \
    -I "$root/$name" -I proto "$root/$name"/*.proto
done
