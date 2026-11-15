# @huaweidevtools/aishell-dsh-qr

Renders short text as a scannable QR code and writes it into the conversation's
working directory, so text that has to reach another device by scanning can be
shown on the screen the conversation is reading from. One host-only tool; no
browser half, no network access, no credential.

## A tool, not an instruction

A model told to "write a QR code" improvises the encoder: run a system binary
that may not be installed, hand-roll a matrix, or paste a base64 blob nothing
can verify. Each fails quietly — the reply renders, the image is simply
unscannable, and neither the model nor the reader finds out until the phone
refuses it.

The tool encodes in-process, so the capability belongs to the plugin and not to
whatever happens to be installed on the host.

## The image is a file

The conversation renders an image by path — `![alt](path.png)` — and strips
`data:` destinations. A file in the working directory is the shape that
displays, and it is also what lets the reader open, drag out, or print the code.

The renderer resolves that destination against the session's working directory,
so the path the tool answers with is the path the reply writes. A subdirectory
works and is created on demand: `qr/recharge.png` displays as `recharge.png`
does.

## What the model sees

```
aishell__qr(text, relativePath, overwrite?)

  text          the exact bytes to encode — a URL, Wi-Fi credentials, a code
  relativePath  where to write it, relative to the working directory;
                required, because this is the string the reply references
  overwrite     replace an existing file; defaults to false
```

It answers with `{ relativePath, absolutePath }` and tells the reply to show the
image with the encoded text beneath it — a code the user cannot scan has no
fallback unless the same text is beside it. The text is not echoed back: it is
the argument the call was given, so the reply already holds it.

## The two refusals that matter

**An existing path is not replaced unless `overwrite: true`.** A silent replace
leaves every earlier reply that referenced that path showing the new code in
place of the one it described — the reference still resolves, the content
changed underneath it. The tool writes with `wx`, so the refusal is atomic and
two concurrent calls cannot both pass a check.

**A path outside the working directory is refused.** The rendered image and the
trust boundary both stop there, so an absolute path or a `..` segment is
reported and nothing is written.

The path is required. It is the string the reply references, so the caller has
to name it: a name the tool picked is one the model would not know.

## Encoding

`qrcode-generator` builds the matrix; the PNG container is written here — `IHDR`
/ `IDAT` / `IEND` framed over `node:zlib`'s deflate and CRC-32. A QR symbol is
two colours, so a PNG library would be a dependency carried by every install for
a code path that runs when someone asks to pay an invoice.

Verified end to end with `zbarimg`: the image decodes back to the exact text,
including a URL's `#` fragment, which is the part a shell round trip would drop.

## Install

```sh
# On its own.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-qr

# Or with the rest of the aishell plugin set.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## What it does NOT touch

- No network. Nothing leaves the machine.
- No credentials, no cloud API.
- No browser half — nothing to render.
- No files outside the path the caller names.

## One package per general-purpose tool

A new general-purpose tool gets its own package, as every general tool a harness
ships does. This package is not a container: mounting it mounts a QR renderer,
and `dsh plugin add` stays a list of things somebody asked for.

A package carrying several related tools can set `deferLoading: true` on its
definitions to keep their schemas out of the first prompt. This one carries a
single tool, which is one schema.

## License

Apache-2.0