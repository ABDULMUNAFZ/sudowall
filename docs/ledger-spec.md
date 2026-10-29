# Ledger specification: `tg-ledger/1`

This document is the normative spec for the Tortoise Gate ledger. A third party should be able to write an independent verifier from it alone. "MUST", "SHOULD" and "MAY" are used as in RFC 2119.

## 1. What it guarantees, and what it does not

**Guarantee.** Suppose an attacker modifies, deletes, inserts or reorders any entry covered by a signed checkpoint, and does not hold the signing key. Verification will then fail, and it reports the first bad sequence number.

**Not guaranteed:**

- **Entries after the last checkpoint.** They are hash-chained but unsigned. Someone with write access to the file can truncate them or rewrite them consistently. Checkpoints are frequent (default every 256 entries or 60 s) to keep this window short.
- **An attacker with the signing key.** On the same machine, as the same OS user, such an attacker can rewrite the whole ledger and re-sign it. Exporting checkpoints off the machine (and later, optional on-chain anchoring) is what defends against this.
- **Behaviour.** The ledger proves that history was not edited. It does not prove that the agent behaved well, or that every action went through the gate.

## 2. Primitives

- **Hash:** SHA-256. `H(x)` is the 32-byte digest.
- **Signature:** Ed25519 (RFC 8032, pure, no prehash) via `node:crypto`.
- **Integers:** `u64be(n)` is the 8-byte big-endian encoding.
- **Hex:** lowercase, no prefix.
- **base64url:** RFC 4648 §5, no padding.
- **`||`:** byte concatenation. String literals are ASCII bytes, and `0x00` is a single zero byte.

### 2.1 Canonical JSON (`tgjson`)

`tgjson(v)` is RFC 8785 (JSON Canonicalization Scheme), with the clarifications below. Output is UTF-8.

1. Object keys are sorted by UTF-16 code units, recursively. There is no insignificant whitespace.
2. Numbers are serialised as ECMAScript `Number.prototype.toString` does (JCS §3.2.2.3). `-0` is serialised as `0`. `NaN` and `±Infinity` MUST be rejected.
3. Strings are escaped as ECMAScript `JSON.stringify` does (ES2019 well-formed). A lone surrogate is written as a lowercase `\udxxx` escape, not rejected. This is the one deviation from RFC 8785; it exists so the ledger can record every string a tool sent.
4. An own property named `__proto__` is an ordinary key.

Implementation note: tool arguments are parsed with `JSON.parse` before they reach the ledger. An integer larger than 2^53 − 1 has already lost precision at that point. The policy engine therefore treats unsafe integers in amount arguments as an error (fail closed). Money amounts SHOULD be sent as decimal strings.

## 3. Ledger identity and keys

Each ledger has:

- `ledgerId`: a random UUID v4. `ledgerIdBytes` is its 16 raw bytes, in RFC 9562 byte order.
- One Ed25519 key pair. `publicKey` is the 32 raw bytes. `keyId = hex(H(publicKey))[0..32]` (the first 16 bytes, as 32 hex chars).

v1 uses one key per ledger; key rotation is not part of `tg-ledger/1`. The private key is stored in a file with mode `0600`, outside the database. Moving it to the OS keychain is deferred (see `backlog.md`).

## 4. Entries

Entry `seq` (starting at **1**, contiguous, with no gaps) stores one event (see `event-schema.md`). Redaction has already been applied to the event, and the event records the rule version and the redacted paths.

```
prevHash(1)      = 32 zero bytes
prevHash(n)      = entryHash(n-1)
entryHash(n)     = H( "tg-ledger/1 entry" || 0x00 || ledgerIdBytes || u64be(n) || prevHash(n) || tgjson(event_n) )
```

Ordering comes from `seq`. The event's `ts` field is informational and MUST NOT be used for ordering.

## 5. Checkpoints

A checkpoint signs a contiguous block of entries `(fromSeq .. toSeq)`, both inclusive. `fromSeq` is the previous checkpoint's `toSeq + 1`, or `1` for the first checkpoint. A writer MUST create a checkpoint when `everyEntries` entries are pending, when `everySeconds` have passed with entries pending, and on clean shutdown.

### 5.1 Merkle root

`merkleRoot = MTH(entryHash(fromSeq), ..., entryHash(toSeq))` using RFC 6962 §2.1:

```
MTH({})        = H("")                         (not used: blocks are never empty)
MTH({d0})      = H(0x00 || d0)
MTH(D[n])      = H(0x01 || MTH(D[0:k]) || MTH(D[k:n]))   where k = largest power of two < n
```

Inclusion proofs (`ledger proof <seq>`) are RFC 6962 §2.1.1 audit paths against the checkpoint that covers `seq`.

### 5.2 Body and signature

```json
{
  "spec": "tg-ledger/1",
  "ledgerId": "<uuid>",
  "checkpointSeq": 1,
  "fromSeq": 1,
  "toSeq": 256,
  "merkleRoot": "<hex>",
  "lastEntryHash": "<hex of entryHash(toSeq)>",
  "prevCheckpointHash": "<hex; 64 zeros for checkpointSeq 1>",
  "createdAt": "2026-10-29T07:00:00.000Z",
  "keyId": "<32 hex chars>"
}
```

```
checkpointMessage = "tg-ledger/1 checkpoint" || 0x00 || tgjson(body)
signature         = Ed25519.sign(privateKey, checkpointMessage)        (64 bytes)
checkpointHash    = H(checkpointMessage)
```

`prevCheckpointHash` of checkpoint `k` is the `checkpointHash` of checkpoint `k-1`. `checkpointSeq` starts at 1 and is contiguous.

## 6. Export format (JSON Lines)

`ledger export` writes UTF-8 JSON Lines. Each line is a JSON object; the field order within a line does not matter.

1. The first line is the header: `{"kind":"header","spec":"tg-ledger/1","ledgerId":"…","publicKey":"<base64url 32 bytes>","keyId":"…"}`
2. An entry line: `{"kind":"entry","seq":n,"prevHash":"<hex>","hash":"<hex>","event":{…}}`
3. A checkpoint line: `{"kind":"checkpoint","body":{…},"signature":"<base64url 64 bytes>"}`. It appears directly after the entry line for its `toSeq`.

Entries appear in increasing `seq`. Entries after the last checkpoint MAY be present. They are reported as "unsigned tail", not as an error.

## 7. Verification algorithm

Input: an export (or the database). Output: `ok`, or the first failure with its kind and `seq` (or `checkpointSeq`).

1. Parse the header. Check `spec == "tg-ledger/1"` and `keyId == hex(H(publicKey))[0..32]`. If an expected public key or `keyId` was supplied out of band, it MUST match.
2. For each entry in order, with `expectedSeq` starting at 1:
   1. `seq == expectedSeq`, otherwise fail `SEQ_GAP` (deletion or reorder) or `SEQ_DUPLICATE` (insertion).
   2. The event parses against the event schema for its `schemaVersion`, otherwise fail `BAD_EVENT`.
   3. `prevHash` equals the previous computed `entryHash` (zeros for seq 1), otherwise fail `CHAIN_BREAK`.
   4. Recompute `entryHash`. It must equal `hash`, otherwise fail `HASH_MISMATCH`.
3. For each checkpoint in order:
   1. `checkpointSeq` is contiguous from 1. `fromSeq` is the previous `toSeq + 1`, or 1 for the first. `fromSeq ≤ toSeq`. `ledgerId` and `keyId` match the header. Otherwise fail `CHECKPOINT_SEQUENCE`.
   2. The Ed25519 signature verifies over `checkpointMessage`, otherwise fail `BAD_SIGNATURE`.
   3. `prevCheckpointHash` matches, otherwise fail `CHECKPOINT_CHAIN_BREAK`.
   4. `lastEntryHash == entryHash(toSeq)` and `merkleRoot` matches the recomputed root, otherwise fail `CHECKPOINT_MISMATCH`, reporting the lowest `seq` in the block whose hash differs from the signed one where determinable.
4. Report `ok` with `lastSignedSeq` and `unsignedTail = lastSeq - lastSignedSeq`.

## 8. Redaction

Redaction runs **before** the event is hashed, so the chain commits to the redacted form, and redacted secrets never enter the database. Each rule (see `ConfigSchema.redaction`) selects a JSON Pointer in arguments and/or result:

- `removed`: the value is replaced by the string `"[redacted]"`.
- `hmac-sha256`: the value is replaced by `"hmac-sha256:" || hex(HMAC-SHA256(redactionKey, tgjson(value)))`. This lets an investigator test whether two redacted values were equal, without exposing them, and resists brute-forcing low-entropy secrets. `redactionKey` is 32 random bytes per ledger, stored next to the signing key with mode `0600`.

The event records `redaction.ruleVersion` and every `{path, method}` applied. Changing the rules means incrementing `ruleVersion`.

## 9. Storage (informative)

SQLite in WAL mode with `synchronous = FULL` for entry commits. Tables: `meta(ledger_id, spec, public_key, key_id)`, `entries(seq PRIMARY KEY, event_json, prev_hash, hash)`, `checkpoints(checkpoint_seq PRIMARY KEY, body_json, signature)`. The export format, not the table layout, is the interoperability contract.
