# Dispatch Call Reconciler — Trial

This folder contains experimental reconcilers that analyze transcripts from all dispatch feeds (DISP 1/2/4/etc.) and emit a single corrected/hybrid call as **DISP 3**.

## Goal

- **DISP 2** runs Whisper v3 Turbo on one machine.
- **DISP 4** (this machine) runs Whisper medium.
- **DISP 3** becomes the "hybrid" master feed: it picks the best parts of every feed for each call and emits one corrected dispatch.

## Two approaches

### 1. Rule-based reconciler (`reconciler.mjs`)

No external APIs. Uses heuristics to:

- Cluster events from all feeds by time + location.
- Score each transcript on dispatch signal strength, address quality, and noise phrases.
- Pick the best address, signal type, and transcript per cluster.
- POST a `DISP 3` event through the local dispatch API.

**Pros:** Free, fast, deterministic, no network latency.  
**Cons:** Dumber than an LLM; can't reason about context or paraphrase.

### 2. LLM-based reconciler (`reconciler-llm.mjs` — template only)

Sends clustered transcripts to an LLM (OpenAI, Grok, local Ollama, etc.) with a prompt asking for the corrected dispatch.

**Pros:** Can understand context, resolve contradictions, and produce cleaner summaries.  
**Cons:** Costs money/token, adds latency, needs prompt tuning and rate-limit handling.

## Current trial

We are running **option 1** (rule-based) first. It writes `DISP 3` events to the same MongoDB used by dispatch-monitor and nexus-dispatch.

## Files

- `reconciler.mjs` — rule-based reconciler
- `reconciler-llm.mjs` — LLM-based template
- `run-reconciler.bat` — Windows batch launcher
- `.env.example` — environment variables

## Running

```powershell
cd C:\Users\str8s\dispatch-monitor\trial
node reconciler.mjs
```

Or double-click `run-reconciler.bat`.

## Configuration

Edit `.env` in the project root (or pass env vars):

```env
RECONCILER_API_URL=http://127.0.0.1:5000
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=str8stratag_db_user
```

## How it decides "best"

Each transcript gets a score based on:

- Dispatch signal keywords (`signal 4`, `mva`, `rollover`, etc.)
- Numeric street address present
- Known Tampa/Hillsborough street names
- Penalties for TV/video phrases, generic addresses (`street`, `drive`, `high park`), and repetitive spam

The highest-scoring transcript in a cluster drives the `DISP 3` event, with the best address/signal type selected from all cluster members.
