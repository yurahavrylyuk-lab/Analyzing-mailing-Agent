# DQ-032 Gemini Website Analysis Adapter Design

## Status

```text
design, human-approved, not implemented
```

## Goal

DQ-032 analyzes one `WebsiteFacts` value with Gemini and returns one validated provider-neutral `WebsiteAnalysis` plus minimal execution provenance.

Flow:

```text
WebsiteFacts
→ Gemini Interactions API
→ structured unknown candidate
→ validateWebsiteAnalysis()
→ WebsiteAnalysis + minimal Gemini provenance
```

DQ-031 remains the authority for semantic validation.

Keep the design deliberately small. No speculative interfaces, repositories, factories, DI containers, telemetry systems, retry frameworks, or abstraction layers.

## Public operation

One operation equivalent to:

```ts
analyzeWebsiteWithGemini(
  facts: WebsiteFacts,
  config: GeminiWebsiteAnalysisConfig
): Promise<GeminiWebsiteAnalysisResult>
```

Do not add a generic multi-provider router in DQ-032.

`GeminiWebsiteAnalysisConfig` is the enabled branch of the central application config described below. Production callers pass that enabled value. Unit tests may also pass one optional `fetch` function, the same kind of seam `GeoapifyProviderOptions` uses. That optional function is not a factory, registry, or container.

## Result envelope

Minimal result:

```ts
type GeminiWebsiteAnalysisResult = Readonly<{
  analysis: WebsiteAnalysis;
  provider: "gemini";
  model: GeminiModel;
  attemptedModels: readonly GeminiModel[];
}>;
```

Freeze the result root and `attemptedModels`. `analysis` is already frozen by DQ-031.

`attemptedModels` is a new array containing only the models this call actually attempted, in chain order, including the model that succeeded. Do not freeze an internal mutable list in place.

Do NOT add tokens, cost, latency, requestId, interactionId, fallbackDepth, or timestamps. Those are later concerns.

## Model chain

`GeminiModel` is exactly:

```ts
type GeminiModel =
  | "gemini-3.8-flash"
  | "gemini-3.6-flash"
  | "gemini-3.5-flash-lite"
  | "gemini-3.1-flash-lite";
```

Exact immediate order:

```text
gemini-3.8-flash
→ gemini-3.6-flash
→ gemini-3.5-flash-lite
→ gemini-3.1-flash-lite
```

Do not include deprecated `gemini-3.5-flash` or `gemini-3.7-flash`, because they route to newer models and would duplicate effective fallbacks.

One attempt per model. No same-model immediate retry.

## Fallback rule

Fallback happens only when no HTTP response is obtained because of a transport failure.

An HTTP response is a completed response that has a status code. A network connection error, DNS failure, TLS failure, socket failure, or abort caused by the 30-second timeout is not an HTTP response.

Examples that DO trigger the next model:

- network connection error
- DNS/TLS/socket failure
- request timeout
- abort caused by the configured timeout

Examples that DO NOT trigger fallback:

- HTTP 400
- HTTP 401
- HTTP 403
- HTTP 429
- HTTP 5xx
- successful HTTP response with malformed payload
- successful response with unusable structured output
- DQ-031 validation failure
- provider refusal/safety response delivered over HTTP

A status in 200–299 is a successful HTTP response. Any other status is a non-success HTTP response. Both stop the model chain.

Once an HTTP response exists, model fallback stops.

If all four models transport-fail: `GEMINI_TRANSPORT_UNAVAILABLE`.

## Timeout

Each model request gets 30 seconds. No response within 30 seconds means transport failure and advances to the next model. Do not add a general retry library.

## 90-second retry boundary

The approved future behavior is: the first complete Gemini chain transport-fails, then defer that website, continue other websites, and retry once after at least 90 seconds. That belongs to DQ-033, not DQ-032.

DQ-032 performs only one immediate four-model pass. No timers or scheduling for the 90-second retry are implemented here.

## Gemini transport

Use direct REST. No Google GenAI SDK.

Endpoint:

```text
POST https://generativelanguage.googleapis.com/v1/interactions
```

Authentication:

```text
x-goog-api-key: GEMINI_API_KEY
```

Request is single-turn, stateless, `store: false`, and non-streaming. No `previous_interaction_id`. No server-side conversation state.

## Input sent to Gemini

Send only public deterministic website information already present in `WebsiteFacts`:

evidenceId, leadId, leadVersion, requestedUrl, finalUrl, title, metaDescription, documentLanguage, hasViewport, h1Count, headingCount, imageCount, imagesWithoutAlt, formCount, internalLinkCount, externalLinkCount, visibleText.

No raw HTML. No secrets. No private contacts. No internal lead notes. No unrelated database state.

## Prompt responsibility

One fixed prompt/template owned by DQ-032. Do not make prompts configurable yet.

Tell Gemini to analyze only the supplied facts/text across design, usability, seo, accessibility, and conversion. Severity is low, medium, or high. Each finding must include observation, evidence, and recommendation.

The prompt must prohibit invented facts, screenshot/visual inference not supported by inputs, qualification decisions, contact recommendations, outreach generation, scores, and extra semantic fields.

## Structured output

Use Gemini `response_format` with a simple JSON schema corresponding to DQ-031: evidenceId, leadId, leadVersion, summary, and findings[]. Each finding has category, severity, observation, evidence, and recommendation.

Provider-side structured output is only an output-shaping aid. It is NOT trusted validation.

Always pass the parsed candidate through `validateWebsiteAnalysis(facts, candidate)`. Do not duplicate DQ-031 validation inside the Gemini adapter.

Keep the provider schema simple. Do not try to encode every DQ-031 application constraint into Gemini's JSON schema if application validation already handles it. In particular, avoid unnecessary provider-schema complexity such as array-count constraints. DQ-031 remains responsible for total and per-category finding bounds.

## Configuration

Extend central app configuration consistently with existing repo patterns.

Environment:

```text
WEBSITE_ANALYSIS_PROVIDER=disabled | gemini
GEMINI_API_KEY=<secret>
```

Behavior:

- provider missing → disabled
- provider=disabled → disabled
- provider=gemini + valid key → enabled
- provider=gemini + missing/invalid key → configuration error
- unknown provider → configuration error

`GeminiWebsiteAnalysisConfig` is not a second configuration system. `loadConfig` in `src/config/env.ts` parses these variables and stores the result on `AppConfig`, parallel to `discovery`.

```ts
type WebsiteAnalysisConfig =
  | Readonly<{ provider: "disabled" }>
  | GeminiWebsiteAnalysisConfig;

type GeminiWebsiteAnalysisConfig = Readonly<{
  provider: "gemini";
  apiKey: string;
}>;
```

Only the exact strings `disabled` and `gemini` are known. Missing and `disabled` are disabled. Any other value, including a different case, is an unknown provider. Do not case-fold.

A key is invalid when it is empty or contains whitespace or a control character. That is the same rule already used for `GEOAPIFY_API_KEY`. Do not add another validity rule.

Configuration failures use one error class in `src/config/errors.ts`, in the same style as `DiscoveryConfigurationError`: a fixed code, a fixed message, `readonly name`, and no `cause`. The message names the variable and the allowed provider values. It does not include the rejected provider text or the API key.

Use one explicit credential only. No alternate credential source. No default/demo key. No secret logging. No automatic paid-tier fallback. Keep config parsing free of network I/O.

## Runtime errors

Use a small Gemini-specific runtime error domain.

Required semantics:

- `GEMINI_TRANSPORT_UNAVAILABLE`: all four models failed without producing an HTTP response.
- `GEMINI_HTTP_ERROR`: Gemini produced a non-success HTTP response. No model fallback after that response.
- `GEMINI_INVALID_RESPONSE`: a successful HTTP response cannot produce the expected structured candidate.

Follow the existing website-analysis error style: one frozen code array, one fixed message per code, `readonly name`, and no `cause`. The fixed messages do not interpolate the API key, status text, raw response body, Gemini content, or prompt contents.

Do not include the API key, raw response body, full Gemini content, or prompt contents in errors.

If the candidate reaches DQ-031 and fails validation, propagate `WebsiteAnalysisError` unchanged. Do not wrap it and do not fallback.

## Module boundary

Suggested small structure, not a requirement to split further:

```text
src/website-analysis/providers/gemini/
  gemini-provider.ts
  http.ts
  prompt.ts
  errors.ts
  index.ts
```

If repository conventions allow fewer files without harming clarity, prefer fewer files.

Do NOT introduce a provider registry, factory layer, repository, service container, generic retry engine, generic AI abstraction, or generic fallback router. DQ-032 is one Gemini adapter.

## Testing strategy

Tests must use an injected/mock transport seam. No real Gemini requests in unit tests.

The seam is the optional `fetch` function described above. Tests control responses and abort timing through that function. They do not read source text to prove a provider name is absent.

Prove:

- 3.8 success → only 3.8 attempted
- 3.8 transport failure → 3.6 attempted
- first two transport-fail → 3.5 Flash-Lite attempted
- first three transport-fail → 3.1 Flash-Lite attempted
- all four transport-fail → GEMINI_TRANSPORT_UNAVAILABLE
- HTTP 429 → stop, no fallback
- HTTP 500 → stop, no fallback
- HTTP auth failure → stop, no fallback
- malformed success response → no fallback
- DQ-031 rejection → no fallback
- correct model order
- attemptedModels contains only actual attempts
- successful model recorded
- result frozen
- API key not exposed in errors
- store:false
- correct endpoint
- correct request data
- no raw HTML sent
- 30-second abort behavior without making tests wait 30 real seconds
- configuration disabled/enabled/error behavior

No brittle source-grep tests.

## Explicit exclusions

DQ-032 does NOT add: multi-website run, 90-second delayed retry, 50/day budget, analysis persistence, D1 changes, SQLite changes, migrations, Groq, Cloudflare Workers AI, OpenRouter, cross-provider fallback, qualification, lead scoring, contact discovery, do-not-contact execution, email drafting, email sending, scheduler, GitHub Actions, queues, background jobs, or a new AI SDK dependency.

## Future sequence

Document only, do not implement:

```text
DQ-033
bounded multi-website analysis run
+ sequential processing
+ deferred 90-second retry
+ one retry round
+ continue processing remaining websites
+ daily run/budget policy

DQ-034
analysis persistence + selected provenance

Later phases
qualification
→ contact discovery
→ DNC/contact guard
→ outreach drafting
→ human approval
→ approved sending
```

## Completion boundary

DQ-032 is complete when one WebsiteFacts can reach Gemini through direct REST, use transport-only model fallback, produce one structured candidate, pass through DQ-031, and return WebsiteAnalysis plus minimal Gemini provenance, and nothing beyond that.
