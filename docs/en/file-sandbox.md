# File admission, reconstruction and security boundaries

[中文原文](../文件沙箱.md) · [English index](README.md)

“File sandbox” means application-level admission, bounded parsing and content reconstruction. Original upload bytes must not become browser previews or model-image inputs. Only reconstructed output is consumed. Invalid format, timeout, parser failure and size violations reject the file; there is no fallback to original bytes.

**This is not complete operating-system isolation or antivirus.** Native image decoders and child processes run under the server's OS user. There is no separate restricted identity/token, network isolation or hard total RSS limit. Passing admission is not proof that a file is harmless.

## Covered entry points

| Entry | Admission and output |
| --- | --- |
| Batch assets | Strict TXT/Markdown/JSON decoding; JSON reserialized. PNG/JPEG/WebP fully decoded and encoded as PNG. Publish only after the whole batch passes. |
| Cover | Decode/reencode PNG and persist the reconstructed copy. |
| Local avatar | Server checks first; browser decodes only returned PNG before local cropping. |
| Manual chapter TXT | Server strictly decodes selected UTF-8 or GB18030, then returns checked text to the editor. |
| Temporary DOCX | Validate the entire ZIP, convert in a child process and allowlist semantic HTML, removing images/links/styles/objects/active content. Never serve original OOXML. |
| PDF | Rejected: reliable content reconstruction is unavailable. Signature checks alone do not admit it. |
| Existing uploaded images | UUID filenames and PNG/JPG/JPEG/WebP only; bounded safe read and fresh PNG reconstruction. Old originals are not overwritten or served directly. |
| Model-image outbound | Use the same safe reader/reconstruction; stored MIME/extension alone is not trusted. |

Server limits are authoritative. Outer routes still enforce identity, tenant and CSRF boundaries. Pasted prose is ordinary text, not executable HTML. Implementation: [admission](../../packages/server/src/features/file-sandbox/sandbox.ts), [multipart](../../packages/server/src/features/file-sandbox/upload.ts), [leases](../../packages/server/src/features/file-sandbox/upload-lease.ts), [safe read](../../packages/server/src/features/file-sandbox/safe-read.ts), [document parser](../../packages/server/src/features/documents/parser.ts).

## Separate web delivery retains upload protections

Backend `SERVE_WEB=false` disables only static web/SPA hosting, not protected `/uploads` reads or file APIs. A separate static entry must proxy `/api` and `/uploads` on the same origin to one backend, never directly mount data/upload originals or turn file errors into SPA HTML. Cookie/origin/tenant/CSRF checks remain intact. `WEB_DIST_DIR` is for trusted frontend output, never business data. See [deployment instructions](user-guide.md#separate-builds-and-same-origin-deployment). This adds no OS isolation.

## Limits and rejection

MiB means 1,048,576 bytes. A particular business endpoint may impose a smaller limit (manual chapter creation also documents a 2,000,000-byte UI/business cap).

| Resource | Limit |
| --- | --- |
| Text assets/manual TXT admission | 2 MiB/file; reject empty input, invalid encoding and binary control characters. |
| Image assets/covers | 4 MiB/file. |
| Avatar/DOCX input | 8 MiB/file. |
| Batch | 10 files; multipart fields, bytes and total parts are bounded too. |
| Existing-image read/reconstructed output | 16 MiB; does not enlarge external upload caps. |
| Image dimensions | 24,000,000 pixels; each side at most 6000; reject multipage images. |
| Image decoding | Child process, sharp cache off/concurrency 1, V8 old-space 96 MiB, ten seconds. |
| DOCX ZIP | 8 MiB compressed, 512 entries, 32 MiB actual expansion, 200:1 per entry, five seconds. |
| DOCX conversion | Child process, V8 old-space 128 MiB, ten seconds, 4 MiB HTML output. |
| Temporary copies | 10/project, 64/runtime, 64 MiB total, 30-minute expiry. |

Image signatures must agree with suffixes and full decoding must succeed. Reencoding strips original metadata and appended JPEG/PNG payloads. SVG, executables and disguised images are rejected. DOCX rejects unsafe/duplicate paths, encryption, symlinks, abnormal compression, macros, external relationships, XML entities and active embedded content before HTML allowlisting.

Safe reading rejects directories, symlinks, path escape and detected replacement. Every read sanitizes again; there is no permanent “scanned safe” state or stale result cache. Originals remain sensitive and protected by directory permissions. This does not defeat a malicious actor with local file-write privileges.

## Cancellation and concurrency

Each runtime process has two processing leases shared by uploads and image reads. Multi-tenant Workers count separately; capacity is not globally two for the whole deployment.

Acquire a lease **before multipart buffering**. Disconnect during parsing stops input/cancels the lease and prevents late callbacks from starting scans. After parsing, disconnect cancels processing and terminates an active decoder; the permit is released only after child close and handler `finally` cleanup. Repeated disconnects cannot free slots while decoders still run. Validation/empty-file early returns also release in `finally`.

Child processes receive a minimal environment allowlist, cleared `NODE_OPTIONS` and a dependency-directory working directory rather than secrets/data directories. Unavailable parsers reject input; callers must never catch errors and use raw bytes instead.

## Remaining risk and deployment

V8 old-space is not total process memory: Buffers, native libraries and OS allocations can live outside it. Pixel/timeout/concurrency caps mitigate risk but do not replace OS CPU/memory/process quotas. Some bounded ZIP verification remains in the service process. Tests cover disguise, payload stripping, dimensions, dangerous DOCX, safe reads and disconnect leases, not absence of vulnerabilities in sharp/libvips/ZIP/conversion libraries or malware detection.

Node 22 permission flags can be an additional misuse guard (`--permission` from 22.13.0; earlier Node 22 uses `--experimental-permission`). They are **not enabled in this implementation** and do not sandbox hostile native code. See [Node's permission documentation](https://nodejs.org/docs/latest-v22.x/api/permissions.html).

For hostile/public uploads, move parsing into real OS isolation under an identity unable to read novels, database passwords, browser sessions or server keys. Use bounded IPC only. Windows options include AppContainer/restricted tokens and Job Objects for memory/CPU/process limits and group termination, with network explicitly denied. Linux options include isolated UID, minimal read-only dependencies, no-network namespaces, seccomp and cgroup quotas. A container name alone is not isolation. Maintain pinned parser updates and failure-path tests. These are deployment recommendations, not completed protections or a public-Internet safety promise.
