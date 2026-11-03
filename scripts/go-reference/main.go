// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.

// Command go-reference records what protowire-go does with every vendored
// corpus fixture: whether each leg accepts it and, when it does, the
// deterministic protobuf bytes it binds. corpus.test.ts holds this port to
// the record, so the reference is the oracle rather than a verdict table.
//
//	go run . ../../src/pxf/testdata/corpus > ../../src/pxf/testdata/corpus/reference.json
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/trendvidia/protowire-go/encoding/pxf"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// Leg is one way of reading a fixture. Hex holds one entry per bound
// message: one for a body, one per row for @dataset.
type Leg struct {
	Accept bool     `json:"accept"`
	Hex    []string `json:"hex,omitempty"`
}

// Record is a fixture's outcome on each leg. Stream is set for @dataset only.
type Record struct {
	Parse  bool `json:"parse"`
	Decode Leg  `json:"decode"`
	Stream *Leg `json:"stream,omitempty"`
}

var typeLine = regexp.MustCompile(`(?m)^@(?:type|dataset)\s+([\w.]+)`)

var opts = proto.MarshalOptions{Deterministic: true}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go-reference CORPUS_DIR")
		os.Exit(2)
	}
	out := map[string]Record{}
	dirs, err := filepath.Glob(filepath.Join(os.Args[1], "*", "*.binpb"))
	check(err)
	for _, binpb := range dirs {
		dir := filepath.Dir(binpb)
		files, o := load(binpb)
		fixtures, err := filepath.Glob(filepath.Join(dir, "*.pxf"))
		check(err)
		nested, err := filepath.Glob(filepath.Join(dir, "*", "*.pxf"))
		check(err)
		for _, path := range append(fixtures, nested...) {
			if strings.Contains(path, ".expected.") {
				continue
			}
			data, err := os.ReadFile(path)
			check(err)
			m := typeLine.FindSubmatch(data)
			if m == nil {
				continue
			}
			d, err := files.FindDescriptorByName(protoreflect.FullName(m[1]))
			check(err)
			key, err := filepath.Rel(os.Args[1], path)
			check(err)
			out[filepath.ToSlash(key)] = record(data, d.(protoreflect.MessageDescriptor), o)
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	check(enc.Encode(out))
}

// resolver adapts a file set to pxf.TypeResolver.
type resolver struct{ types *dynamicpb.Types }

func (r resolver) FindMessageByURL(url string) (protoreflect.MessageDescriptor, error) {
	t, err := r.types.FindMessageByURL(url)
	if err != nil {
		return nil, err
	}
	return t.Descriptor(), nil
}

func load(path string) (*protoregistry.Files, pxf.UnmarshalOptions) {
	raw, err := os.ReadFile(path)
	check(err)
	var set descriptorpb.FileDescriptorSet
	check(proto.Unmarshal(raw, &set))
	files, err := protodesc.NewFiles(&set)
	check(err)
	return files, pxf.UnmarshalOptions{TypeResolver: resolver{dynamicpb.NewTypes(files)}}
}

func record(data []byte, desc protoreflect.MessageDescriptor, o pxf.UnmarshalOptions) Record {
	doc, parseErr := pxf.Parse(data)
	r := Record{Parse: parseErr == nil}
	if parseErr == nil && len(doc.Datasets) > 0 || bytes.Contains(data, []byte("\n@dataset ")) || bytes.HasPrefix(data, []byte("@dataset ")) {
		r.Decode = bindParsed(doc, parseErr, desc, o)
		s := bindStream(data, desc, o)
		r.Stream = &s
		return r
	}
	msg := dynamicpb.NewMessage(desc)
	err := o.Unmarshal(data, msg)
	if err == nil {
		r.Decode = Leg{Accept: true, Hex: []string{encode(msg)}}
	}
	return r
}

func bindParsed(doc *pxf.Document, parseErr error, desc protoreflect.MessageDescriptor, o pxf.UnmarshalOptions) Leg {
	if parseErr != nil {
		return Leg{}
	}
	leg := Leg{Accept: true}
	for _, ds := range doc.Datasets {
		for _, row := range ds.Rows {
			msg := dynamicpb.NewMessage(desc)
			if err := o.BindRow(msg, ds.Columns, row); err != nil {
				return Leg{}
			}
			leg.Hex = append(leg.Hex, encode(msg))
		}
	}
	return leg
}

func bindStream(data []byte, desc protoreflect.MessageDescriptor, o pxf.UnmarshalOptions) Leg {
	reader, err := o.NewDatasetReader(bytes.NewReader(data))
	if err != nil {
		return Leg{}
	}
	leg := Leg{Accept: true}
	for {
		msg := dynamicpb.NewMessage(desc)
		err := reader.Scan(msg)
		if errors.Is(err, io.EOF) {
			return leg
		}
		if err != nil {
			return Leg{}
		}
		leg.Hex = append(leg.Hex, encode(msg))
	}
}

func encode(m proto.Message) string {
	b, err := opts.Marshal(m)
	check(err)
	return hex.EncodeToString(b)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
