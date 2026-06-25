# Document skills

Vendored from Anthropic's official document skills (docx, pdf, xlsx, pptx).
The agent invokes these when reading or producing those file types. Their Python
dependencies are installed into the project-local `.venv` by `setup.ps1`
(see Dependencies & Setup in the design spec).

Images are NOT handled here — the agent reads images directly with its vision.
There is no OCR step.
