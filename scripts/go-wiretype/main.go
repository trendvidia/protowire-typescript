// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.

// Command go-wiretype records what protobuf-go and protowire-go do with a
// tag of every wire type on every field (trendvidia/protowire#614): the
// inputs of protowire-go's encoding/pb/wire_type_test.go, and the same records
// inside the big-number messages. src/pb/wire-type.test.ts holds this port to
// the record.
//
//	go run . > ../../src/pb/testdata/wiretype-go.tsv
//
// Each line is: the input's hex; protobuf-go's verdict; on accept, the hex
// protobuf-go writes for what it read, unknown fields dropped, and on reject
// "-"; then protowire-go's error, or "-" when it accepts.
package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"math/big"
	"os"

	"github.com/trendvidia/protocompile"
	"github.com/trendvidia/protowire-go/encoding/pb"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/dynamicpb"
)

// conf.proto of protowire-go's conformance_test.go, and the big-number
// messages of pxf.proto under a holder.
const src = `
syntax = "proto3";
package conf;

message Inner {
  string name = 1;
  int64 n = 2;
}

message All {
  string s = 1;
  int64 i64 = 2;
  int32 i32 = 3;
  uint64 u64 = 4;
  uint32 u32 = 5;
  sint64 z64 = 6;
  sint32 z32 = 7;
  bool b = 8;
  double f64 = 9;
  float f32 = 10;
  bytes buf = 11;
  Inner inner = 12;
  repeated Inner list = 13;
  repeated uint32 nums = 14;
  repeated sint64 zigs = 15;
  repeated float reals = 16;
  repeated string strs = 17;
  map<string, int64> m = 18;
  map<int32, Inner> mm = 19;
  oneof choice {
    string a = 20;
    int64 c = 21;
    Inner d = 22;
  }
  repeated bool flags = 23;
  repeated int64 negs = 24;
  map<bool, bool> bm = 25;
}

message BigInt {
  bytes abs = 1;
  bool negative = 2;
}

message Decimal {
  bytes unscaled = 1;
  int32 scale = 2;
  bool negative = 3;
}

message BigFloat {
  bytes mantissa = 1;
  int32 exponent = 2;
  uint32 prec = 3;
  bool negative = 4;
}

message BigNums {
  BigInt i = 1;
  Decimal d = 2;
  BigFloat f = 3;
}
`

// protowire-go's twins: confAll is conformance_test.go's.
type confInner struct {
	Name string `protowire:"1"`
	N    int64  `protowire:"2"`
}

type confAll struct {
	S     string               `protowire:"1"`
	I64   int64                `protowire:"2"`
	I32   int32                `protowire:"3"`
	U64   uint64               `protowire:"4"`
	U32   uint32               `protowire:"5"`
	Z64   int64                `protowire:"6,zigzag"`
	Z32   int32                `protowire:"7,zigzag"`
	B     bool                 `protowire:"8"`
	F64   float64              `protowire:"9"`
	F32   float32              `protowire:"10"`
	Buf   []byte               `protowire:"11"`
	Inner *confInner           `protowire:"12"`
	List  []*confInner         `protowire:"13"`
	Nums  []uint32             `protowire:"14"`
	Zigs  []int64              `protowire:"15,zigzag"`
	Reals []float32            `protowire:"16"`
	Strs  []string             `protowire:"17"`
	M     map[string]int64     `protowire:"18"`
	MM    map[int32]*confInner `protowire:"19"`
	A     string               `protowire:"20"`
	C     int64                `protowire:"21"`
	D     *confInner           `protowire:"22"`
	Flags []bool               `protowire:"23"`
	Negs  []int64              `protowire:"24"`
	BM    map[bool]bool        `protowire:"25"`
}

type bigNums struct {
	I *big.Int   `protowire:"1"`
	D *big.Rat   `protowire:"2"`
	F *big.Float `protowire:"3"`
}

// wireRecords is wire_type_test.go's: every wire type on field num, each
// well formed and cut short.
func wireRecords(num protowire.Number) [][]byte {
	tag := func(typ protowire.Type) []byte { return protowire.AppendTag(nil, num, typ) }
	cat := func(parts ...[]byte) []byte {
		var b []byte
		for _, p := range parts {
			b = append(b, p...)
		}
		return b
	}
	return [][]byte{
		cat(tag(protowire.VarintType), []byte{0x01}),
		cat(tag(protowire.VarintType), []byte{0x80}), // cut short
		cat(tag(protowire.Fixed64Type), []byte{1, 0, 0, 0, 0, 0, 0, 0}),
		cat(tag(protowire.Fixed64Type), []byte{1, 0, 0}), // cut short
		cat(tag(protowire.BytesType), []byte{0x00}),
		cat(tag(protowire.BytesType), []byte{0x01, 0x01}),
		cat(tag(protowire.BytesType), []byte{0x01}), // cut short
		cat(tag(protowire.StartGroupType), tag(protowire.EndGroupType)),
		tag(protowire.StartGroupType), // never ended
		tag(protowire.EndGroupType),   // ends nothing
		cat(tag(protowire.Fixed32Type), []byte{1, 0, 0, 0}),
		cat(tag(protowire.Fixed32Type), []byte{1, 0}), // cut short
		cat(protowire.AppendVarint(nil, uint64(num)<<3|6), []byte{0x01}),
		cat(protowire.AppendVarint(nil, uint64(num)<<3|7), []byte{0x01}),
	}
}

func within(outer protowire.Number, rec []byte) []byte {
	b := protowire.AppendTag(nil, outer, protowire.BytesType)
	return protowire.AppendBytes(b, rec)
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// allInputs is wire_type_test.go's wireTypeInputs.
func allInputs() [][]byte {
	var out [][]byte
	for num := protowire.Number(1); num <= 25; num++ {
		out = append(out, wireRecords(num)...)
	}
	for _, outer := range []protowire.Number{12, 13, 18, 19, 22, 25} {
		for inner := protowire.Number(1); inner <= 3; inner++ {
			for _, rec := range wireRecords(inner) {
				out = append(out, within(outer, rec))
			}
		}
	}
	return append(out,
		mustHex("0a0161"+"0801"),
		mustHex("1007"+"1501000000"),
		mustHex("720101"+"7001"),
		mustHex("7001"+"7501000000"),
		// A group with fields in it, and one closed by another field's end.
		mustHex("cb01"+"0801"+"1a0161"+"cc01"+"0801"),
		mustHex("cb01"+"0801"+"d401"),
	)
}

// bigInputs puts every record of fields 1 to 5 inside each big-number
// message, after a well-formed value of each of its fields, so a skipped
// record shows by leaving the field as that value.
func bigInputs() [][]byte {
	prefix := map[protowire.Number]string{
		1: "0a0105" + "1001",                   // BigInt{abs: 5, negative}
		2: "0a010f" + "1002" + "1801",          // Decimal{unscaled: 15, scale: 1, negative}
		3: "0a0101" + "1003" + "1835" + "2001", // BigFloat{mantissa: 1, exponent: 3, prec: 53, negative}
	}
	var out [][]byte
	for outer := protowire.Number(1); outer <= 3; outer++ {
		for inner := protowire.Number(1); inner <= 5; inner++ {
			for _, rec := range wireRecords(inner) {
				out = append(out, within(outer, rec))
				out = append(out, within(outer, append(mustHex(prefix[outer]), rec...)))
			}
		}
	}
	return out
}

func main() {
	files, err := (&protocompile.Compiler{
		Resolver: protocompile.WithStandardImports(&protocompile.SourceResolver{
			Accessor: protocompile.SourceAccessorFromMap(map[string]string{"conf.proto": src}),
		}),
	}).Compile(context.Background(), "conf.proto")
	if err != nil {
		panic(err)
	}
	msgs := files[0].Messages()
	fmt.Println("# protobuf-go v1.36.12 and protowire-go v1.19.0 on a tag of every wire type (protowire#614).")
	fmt.Println("# Generated by scripts/go-wiretype. Each line: input hex, protobuf-go's verdict,")
	fmt.Println("# the hex protobuf-go writes for what it read without unknown fields (or -),")
	fmt.Println("# and protowire-go's error (or -). A line under \"@ BigNums\" is that message.")
	fmt.Println("@ All")
	emit(msgs.ByName("All"), allInputs(), func(b []byte) error { var v confAll; return pb.Unmarshal(b, &v) })
	fmt.Println("@ BigNums")
	emit(msgs.ByName("BigNums"), bigInputs(), func(b []byte) error { var v bigNums; return pb.Unmarshal(b, &v) })
}

func emit(md protoreflect.MessageDescriptor, inputs [][]byte, ours func([]byte) error) {
	accepted, rejected := 0, 0
	for _, in := range inputs {
		oracle := dynamicpb.NewMessage(md)
		oerr := proto.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(in, oracle)
		perr := ours(in)
		known, gerr := "-", "-"
		verdict := "reject"
		if oerr == nil {
			verdict = "accept"
			accepted++
			b, err := proto.MarshalOptions{Deterministic: true}.Marshal(oracle)
			if err != nil {
				panic(err)
			}
			known = hex.EncodeToString(b)
		} else {
			rejected++
		}
		if perr != nil {
			gerr = perr.Error()
		}
		if (oerr == nil) != (perr == nil) {
			fmt.Fprintf(os.Stderr, "%x: protobuf-go %v, protowire-go %v\n", in, oerr, perr)
		}
		fmt.Printf("%x\t%s\t%s\t%s\n", in, verdict, known, gerr)
	}
	fmt.Fprintf(os.Stderr, "%s: %d inputs, protobuf-go accepts %d, rejects %d\n", md.Name(), len(inputs), accepted, rejected)
}
