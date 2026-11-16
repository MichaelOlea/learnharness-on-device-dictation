# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org/).

## 0.3.0 — not yet released

### Added
- **Model size and precision** setting: besides the compact 8-bit model (still the
  default and the recommended one), the full-precision export of the same model can be
  chosen for every responsiveness step. It is a 2.59 GB download from huggingface.co
  and needs at least 2.5 GB of memory and more CPU. Both can be installed side by side.
  The full-precision model has not yet been tried with the real files.
- The installer can fetch a model that is published as separate files, with the same
  resume, checksum and offline-install behaviour as archives.

### Changed
- The install card and settings quote the disk and memory needs of the model that is
  actually selected.

## 0.2.0 — 2026-11-14

First public release.

### Added
- **Drop-in replacement for LearnHarness's built-in dictation.** The existing Dictate
  button and shortcut now transcribe on-device; no Deepgram key needed
  ("Replace built-in dictation", on by default).
- LearnHarness's Dictation language is followed and mapped to the model's locales.
- The model loads when LearnHarness starts ("Load the model when LearnHarness starts").
- Words that finish after LearnHarness stops waiting are appended to the field.
- Release zip named after the plugin ID, so extracting it gives the right folder.

### Changed
- The separate live-typing button is now an optional extra, off by default.
- Default idle unload is 30 minutes (was 10).

### Removed
- The "Show Dictate in the sidebar" setting (the live button's placements now follow
  its on/off setting). Old settings files still load.

## 0.1.0 — 2026-11-14 (not released publicly)

- Separate on-device Dictate button and shortcut that type words live at the cursor.
- Installer with resumable, checksum-verified downloads and offline install.
- Engine in a worker thread with a separate-process fallback.
