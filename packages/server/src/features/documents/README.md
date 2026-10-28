# Documents integration contract

## Mounting

- Export: `documentsService` from `./documents.js` (`FeatureService.id = 'documents'`). Register after the core projects/auth routes, before fallback/error middleware; for example `createApplication(context, { ...options, services: [documentsService] })`.
- UI: named `DocumentWorkspace` from `packages/web/src/components/documents/DocumentWorkspace.tsx`, prop `{ projectId: string }`. Prefer `key={project.id}` when mounting. No assets/store schema changes.
- Parent page CSP must allow `frame-src 'self'` (existing Cloudflare source may remain). The PDF resource sets its own restrictive CSP and `X-Frame-Options: SAMEORIGIN`; do not globally relax framing/active-content policies.
- Dependencies installed centrally: server `mammoth`, `sanitize-html`, `yauzl`, `yazl`; development `@types/sanitize-html`, `@types/yauzl`, `@types/yazl`. No client document libraries or third-party upload service.

## Routes (all retain existing project authorization, CSRF and local-origin policy)

| Method | Project-relative path                                     | Contract                                                                                                                |
| ------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/projects/:projectId/documents`                      | multipart **file**, one DOCX/PDF; returns `DocumentPreview` (shared/documents.ts), HTTP 201                             |
| GET    | `/api/projects/:projectId/documents/:documentId/resource` | authorized PDF only, no arbitrary paths; application/pdf, private/no-store, nosniff, inline fixed filename, sandbox CSP |
| DELETE | `/api/projects/:projectId/documents/:documentId`          | delete temporary reading copy, returns `{ok:true}`                                                                      |
| GET    | `/api/projects/:projectId/documents/export/docx`          | real OOXML ZIP, ordered canonical project.chapters, escaped XML, safe attachment name                                   |
| GET    | `/api/projects/:projectId/documents/export/epub`          | EPUB3 ZIP, first stored mimetype, package/spine/nav/container, semantic XHTML                                           |
| GET    | `/api/projects/:projectId/documents/print`                | JSON `{title,html}` of ordered escaped canonical chapters; not a served active HTML page                                |

PDF **export is deliberately browser print/save-as-PDF**, not a mislabeled HTML or broken default-font PDF. UI loads only the manuscript into its own script-disabled print iframe and invokes that frame's `print()` from a user click. Uses local Noto CJK/Source Han/Microsoft YaHei/PingFang font stack; users must install a CJK font and check print preview. No bundled licensed font and no claim of guaranteed cross-machine CJK rendering. DOCX/EPUB retain Unicode, relying on readers' installed fonts.

## Security / operational boundaries

- Reading copies are ephemeral in-memory, inaccessible after 30 minutes, lost on restart; not persisted/imported to canonical chapters or assets. Maximum 10/project, 64 global, 64 MiB retained payload. Expired entries are swept on upload/resource reads. No document history/list API.
- Multer admission permits two simultaneous uploads/parses, one file at most 8 MiB. ZIP checks stream **every entry**, max 512 entries, max 32 MiB actual aggregate expansion, max 200:1 per-entry ratio, no duplicates/traversal/encrypted/unsupported compression, 5-second validation deadline.
- DOCX conversion runs Mammoth in a separate process with a 128 MiB V8 heap ceiling (not an OS-level total RSS guarantee), 10-second deadline, 4 MiB output cap; no external file access. Mammoth image conversion never reads image bytes. Sanitizer strips images, anchors, attributes, style, active/embedded content. UI uses a script-disabled opaque sandbox for Word HTML.
- PDF server never parses/decompresses PDF objects. It checks header/trailer only; this is **not** a PDF malware scanner or full conformance validator. Browser native viewer handles content inside sandbox; compatibility varies and the UI offers an authorized new-tab fallback. Keep browsers patched. No text extraction/OCR or third-party viewer.
- `.doc` returns HTTP 415 `LEGACY_DOC_UNSUPPORTED`, with Word/LibreOffice DOCX/PDF conversion guidance.
- Error codes include `DOCUMENT_UPLOAD_LIMIT`, `DOCUMENT_TOO_LARGE`, `DOCUMENT_EXPANSION_LIMIT`, `DOCUMENT_OUTPUT_LIMIT`, `DOCUMENT_STORAGE_LIMIT`, `DOCUMENT_BUSY`, `DOCUMENT_TIMEOUT`, `DOCUMENT_PARSE_FAILED`, `DOCUMENT_NOT_FOUND`, `UNSUPPORTED_DOCUMENT_FORMAT`.
- Existing project middleware may disallow mutations while generation/publication is running; this feature intentionally does not bypass it.

## Verification

`node --import tsx --test packages/server/src/features/documents/documents.test.ts`

Tests inspect actual DOCX/EPUB ZIP contents, roundtrip generated DOCX through isolated Mammoth, check canonical chapter order and exclusions, XML escaping/CJK font hints, sanitizer XSS removal, ZIP duplicate/expansion/size errors, real HTTP multipart/CSRF/project isolation/legacy/mismatched input/8 MiB limit, resource security headers, export download and deletion. This does not substitute for native Word/EPUB-reader interoperability or visual browser/PDF/CJK testing.
