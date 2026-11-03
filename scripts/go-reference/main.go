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
// Type names the message of a fixture with no @type line. Encode is set for an
// enc- case: the text Marshal writes for its .binpb.
type Record struct {
	Type    string `json:"type,omitempty"`
	Parse   bool   `json:"parse"`
	Format  string `json:"format,omitempty"`
	Decode  Leg    `json:"decode"`
	Full    Leg    `json:"full"`
	Discard bool   `json:"discard"`
	Marshal string `json:"marshal,omitempty"`
	Stream  *Leg   `json:"stream,omitempty"`
	Encode  string `json:"encode,omitempty"`
}

var typeLine = regexp.MustCompile(`(?m)^@(?:type|dataset)\s+([\w.]+)`)

var opts = proto.MarshalOptions{Deterministic: true}

// untyped names the message of a directory whose fixtures may carry no @type
// line: an enc- case is exactly the text an encoder writes, which has none.
var untyped = map[string]string{"bigfloat": "bf.v1.H"}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go-reference CORPUS_DIR")
		os.Exit(2)
	}
	out := map[string]Record{}
	dirs, err := filepath.Glob(filepath.Join(os.Args[1], "*"))
	check(err)
	for _, dir := range dirs {
		// A directory's descriptor set is <dir>/<dir>.binpb. Any other .binpb
		// is a fixture's expected bytes.
		binpb := filepath.Join(dir, filepath.Base(dir)+".binpb")
		if _, err := os.Stat(binpb); err != nil {
			continue
		}
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
			name := untyped[filepath.Base(dir)]
			m := typeLine.FindSubmatch(data)
			if m != nil {
				name = string(m[1])
			}
			if name == "" {
				continue
			}
			d, err := files.FindDescriptorByName(protoreflect.FullName(name))
			check(err)
			desc := d.(protoreflect.MessageDescriptor)
			key, err := filepath.Rel(os.Args[1], path)
			check(err)
			r := record(data, desc, o)
			if m == nil {
				r.Type = name
			}
			if strings.HasPrefix(filepath.Base(path), "enc-") {
				r.Encode = encodeWire(strings.TrimSuffix(path, ".pxf")+".binpb", desc, o)
			}
			out[filepath.ToSlash(key)] = r
		}
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	check(enc.Encode(Output{Fixtures: out, Violations: violations(os.Args[1])}))
}

// Output is reference.json.
type Output struct {
	Fixtures   map[string]Record    `json:"fixtures"`
	Violations map[string][]Finding `json:"violations"`
}

// Finding is one bind-time violation.
type Finding struct {
	File    string `json:"file"`
	Element string `json:"element"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
}

var kinds = map[pxf.ViolationKind]string{
	pxf.ViolationField:          "field",
	pxf.ViolationOneof:          "oneof",
	pxf.ViolationEnumValue:      "enumValue",
	pxf.ViolationKeyOption:      "keyOption",
	pxf.ViolationDefaultOption:  "defaultOption",
	pxf.ViolationRequiredOption: "requiredOption",
}

// violations validates the bind-* files of the bind-*-test descriptor sets.
func violations(corpus string) map[string][]Finding {
	out := map[string][]Finding{}
	sets, err := filepath.Glob(filepath.Join(corpus, "..", "bind-*-test.binpb"))
	check(err)
	for _, set := range sets {
		files, _ := load(set)
		files.RangeFiles(func(fd protoreflect.FileDescriptor) bool {
			if !strings.HasPrefix(fd.Path(), "bind-") {
				return true
			}
			found := []Finding{}
			for _, v := range pxf.ValidateFile(fd) {
				found = append(found, Finding{v.File, v.Element, kinds[v.Kind], v.Name})
			}
			out[fd.Path()] = found
			return true
		})
	}
	return out
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
	if parseErr == nil {
		r.Format = string(pxf.FormatDocument(doc))
	}
	if parseErr == nil && len(doc.Datasets) > 0 || bytes.Contains(data, []byte("\n@dataset ")) || bytes.HasPrefix(data, []byte("@dataset ")) {
		r.Decode = bindParsed(doc, parseErr, desc, o)
		s := bindStream(data, desc, o)
		r.Stream = &s
		return r
	}
	skip := o
	skip.DiscardUnknown = true
	r.Discard = skip.Unmarshal(data, dynamicpb.NewMessage(desc)) == nil
	full := dynamicpb.NewMessage(desc)
	if _, err := o.UnmarshalFull(data, full); err == nil {
		r.Full = Leg{Accept: true, Hex: []string{encode(full)}}
	}
	msg := dynamicpb.NewMessage(desc)
	err := o.Unmarshal(data, msg)
	if err == nil {
		r.Decode = Leg{Accept: true, Hex: []string{encode(msg)}}
		text, err := pxf.MarshalOptions{TypeResolver: o.TypeResolver}.Marshal(msg)
		check(err)
		r.Marshal = string(text)
	}
	return r
}

// encodeWire is the text Marshal writes for the PB message in path.
func encodeWire(path string, desc protoreflect.MessageDescriptor, o pxf.UnmarshalOptions) string {
	wire, err := os.ReadFile(path)
	check(err)
	msg := dynamicpb.NewMessage(desc)
	check(proto.Unmarshal(wire, msg))
	text, err := pxf.MarshalOptions{TypeResolver: o.TypeResolver}.Marshal(msg)
	check(err)
	return string(text)
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
