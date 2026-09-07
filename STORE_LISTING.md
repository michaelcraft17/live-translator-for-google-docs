# Chrome Web Store submission notes

Everything the Developer Dashboard asks for, drafted. Paste each section into
the matching field. Anything marked TODO needs your input.

---

## Listing tab

**Name**
`Live Translator for Google Docs`

> Deliberately not "Google Docs Live Translator". Store policy forbids names
> that imply affiliation with or endorsement by another product; leading with
> someone else's trademark is what gets flagged. "X for Y" is the accepted
> phrasing.

**Short description** (132 characters max — this is 118)
`Side-by-side live translation for Google Docs, with click-to-sync highlighting between the document and the translation.`

**Detailed description**
```
Read a Google Doc and its translation side by side, and keep your place in both.

• A translation panel sits beside the document and stays in step as you scroll.
• Click any sentence in the document and the matching translation is highlighted.
• Click a translated sentence and the original is highlighted in the document.
• Headers and footers are translated too, not just the body.
• Works across page breaks, tables, lists and multi-page documents.

You bring your own translation API key (Google Cloud Translation or DeepL), so
your text goes to the provider you choose and to nobody else. The extension has
no server of its own: no account, no telemetry, no data collection.

Open a Google Doc and use the 🌐 button at the top right to turn translation on.
```

**Category** — Productivity / Workflow & Planning
**Language** — English

**Screenshots** — 1280×800 PNG or JPEG, at least one, up to five.

Ready to upload: `store/screenshot-1-sync-highlight.png` — a document with a
sentence highlighted, the matching translation highlighted in the panel, and
the settings popup open. Cropped from a 2000×1160 capture by trimming 144px
off the left (the Google Docs "Document tabs" sidebar) to reach 1280×800's
1.6:1 without distorting anything.

Optional extras, if you want a fuller listing:
2. A highlight spanning a page break — shows off the hard part.
3. A document with a header, showing the header translated in the panel.

> Screenshots are public. Capture on a document you are happy to publish —
> not one with a real name or class period in its header, and never with an
> API key visible.
>
> Note the popup's hint text is legible if a reviewer zooms in, including the
> line about the undocumented endpoint. That is consistent with what the
> permission justification below says, so it is fine — but if you would
> rather not draw attention to it, retake the shot with the popup closed.

---

## Privacy tab

**Single purpose**
```
Displays a translation of the Google Doc the user is reading, side by side
with the original, and keeps the two synchronised so the user can move
between a sentence and its translation.
```

**Permission justifications**

| Permission | Justification to paste |
| --- | --- |
| `storage` | `Stores the user's own settings (target language, translation provider, API key) and a local cache of already-translated sentences, so that reopening a document does not re-translate and re-bill the same text.` |
| `docs.google.com` | `The extension only runs on Google Docs. It reads the open document's text via Google's own export endpoint in order to translate it, and measures the on-screen position of the rendered page so the highlight can be drawn over the correct sentence.` |
| `translation.googleapis.com` | `Sends the document's sentences to the Google Cloud Translation API for translation, using the API key the user supplied.` |
| `api.deepl.com`, `api-free.deepl.com` | `Sends the document's sentences to the DeepL API for translation, using the API key the user supplied. Two hosts because DeepL routes free and paid keys to different endpoints.` |
| `translate.googleapis.com` | `An optional no-key translation endpoint, offered for local development and not the default. Used only if the user explicitly selects it.` |

**Remote code** — Answer **"No, I am not using remote code."** All logic ships
in the package. The extension fetches *data* (the document's exported HTML and
translation results) but never loads or executes remote script.

**Data usage** — disclose:
- **Website content** — collected, because document text is sent to the
  translation provider the user selected.
- Everything else (personal info, health, financial, authentication,
  location, browsing history, user activity): **not collected**.

Then certify all three:
- Not being sold to third parties
- Not being used for purposes unrelated to the single purpose
- Not being used to determine creditworthiness or for lending

**Privacy policy URL** — paste this:

```
https://github.com/michaelcraft17/live-translator-for-google-docs/blob/main/PRIVACY.md
```

The contact email in it is changcheng875@gmail.com. Keep it reachable for as
long as the extension is listed — a dead privacy policy URL gets an item
taken down.

---

## Before you submit

- [x] Contact email set in `PRIVACY.md` (changcheng875@gmail.com)
- [x] Screenshot ready at `store/screenshot-1-sync-highlight.png` (1280×800)
- [x] `./package.sh` builds `dist/live-translator-for-google-docs-1.0.0.zip`
- [x] `PRIVACY.md` published at a public URL (see Privacy tab above)
- [ ] Verify your publisher contact email in the dashboard (required to publish)
- [ ] Pay the one-time $5 developer registration fee

Review is typically a few days. Broad host permissions are the usual reason a
submission goes to slower manual review, so expect this one to take longer
than a trivial extension.
