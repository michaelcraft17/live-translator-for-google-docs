# Privacy Policy — Live Translator for Google Docs

_Last updated: 6 September 2026_

This extension is a local tool. It has no backend server, no account, and no
analytics. The developer does not receive, store, or have any access to your
data. Everything below happens either on your own computer or directly
between your browser and the translation provider you choose.

## What the extension reads

When you open a Google Doc and enable translation, the extension reads that
document's text. It does this through Google's own export endpoint
(`docs.google.com/document/d/<id>/export`), using the Google session already
signed in to your browser — the same content you can see yourself. It reads
the document body, and its headers and footers.

It does not read documents you have not opened, other browser tabs, your
browsing history, your Google account details, or anything outside
`docs.google.com`.

## What leaves your computer, and where it goes

**Document text is sent to the translation provider you select**, and to
nobody else. You choose the provider in the extension's popup:

| Provider you select | Where your text is sent |
| --- | --- |
| Google Cloud Translation API | `translation.googleapis.com`, with your API key |
| DeepL API | `api.deepl.com` or `api-free.deepl.com`, with your API key |
| Unofficial endpoint (development only) | `translate.googleapis.com`, with no key |

Your text is handled by that provider under **their** privacy policy, not
this one. Please read whichever applies to you:

- Google Cloud Translation: <https://cloud.google.com/terms/cloud-privacy-notice>
- DeepL: <https://www.deepl.com/privacy>

The third option talks to an undocumented Google endpoint that requires no
key and offers no terms of service or privacy commitment. It exists for
local development. Do not use it for confidential documents.

No text is sent anywhere else. There is no telemetry, no crash reporting,
and no advertising.

## What is stored, and where

All storage is Chrome's own extension storage on your computer:

- **Your settings** — target language, chosen provider, and **your API key** —
  are kept in `chrome.storage.sync`. Chrome syncs this to your Google account
  so your settings follow you between computers where you are signed in to
  Chrome. If you would rather your API key never leave this device, use the
  unofficial endpoint option or clear the key when you are done.
- **A translation cache** — the source sentences and their translations — is
  kept in `chrome.storage.local` on this device only, so that re-opening a
  document does not re-translate and re-bill everything.
- **Per-document on/off and scroll-sync preferences** are kept in
  `chrome.storage.local`.

## Deleting your data

Removing the extension from Chrome deletes everything it stored, including
the cache and your API key. You can also clear the cache at any time from the
extension's popup.

## Children

This extension is not directed at children and collects no personal
information from anyone.

## Changes

Any change to this policy will be published at this URL along with a new
"last updated" date.

## Contact

Questions about this policy: changcheng875@gmail.com
