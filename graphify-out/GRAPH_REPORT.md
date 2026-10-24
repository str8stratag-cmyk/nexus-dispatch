# Graph Report - dispatch-monitor  (2026-10-24)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1661 nodes · 3622 edges · 112 communities (69 shown, 43 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 105 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4ba79341`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104

## God Nodes (most connected - your core abstractions)
1. `cn()` - 227 edges
2. `registerRoutes()` - 60 edges
3. `react` - 58 edges
4. `AudioPanel()` - 34 edges
5. `handleTelegramUpdate()` - 33 edges
6. `DispatchBufferCore` - 28 edges
7. `lucide-react` - 28 edges
8. `getDatabase()` - 24 edges
9. `Button` - 20 edges
10. `Test-Path()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `2026-10-05 — Telegram Accept-button long-poll (Disp-1 only)` --references--> `handleTelegramUpdate()`  [INFERRED]
  CLAUDE.md → server/routes.ts
- `Local vs shared (READ FIRST)` --references--> `getDatabase()`  [INFERRED]
  AGENTS.md → server/mongodb.ts
- `2026-09-22 — Outage since Friday + 10 code-review findings fixed` --references--> `getDatabase()`  [INFERRED]
  CLAUDE.md → server/mongodb.ts
- `Local vs shared (READ FIRST)` --references--> `getGeocodeQuery()`  [INFERRED]
  AGENTS.md → server/routes.ts
- `2026-09-22 — Outage since Friday + 10 code-review findings fixed` --references--> `getWhisperModel()`  [INFERRED]
  CLAUDE.md → server/whisper.ts

## Import Cycles
- None detected.

## Communities (112 total, 43 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (61): AccordionContent, AccordionItem, AccordionTrigger, Avatar, AvatarFallback, AvatarImage, Breadcrumb, BreadcrumbEllipsis() (+53 more)

### Community 1 - "Community 1"
Cohesion: 0.10
Nodes (47): DispatchEventRow, downloadFile(), EventLog(), eventsToCSV(), eventsToJSON(), neutralizeCsvCell(), ManualDispatch(), ManualDispatchProps (+39 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (40): CaptureLease, DEAD_HOLDER_LEASE_MS, TAB_FRESH_MS, acceptRecoverRequest(), CAPTURE_RECOVER_MIN_GAP_MS, CAPTURE_RECOVER_TTL_MS, CaptureStatusLike, classifyCaptureOutage() (+32 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (53): Local vs shared (READ FIRST), mongodb, getDatabaseName(), isMongoConfigured, broadcastEvent(), buildAcceptKeyboard(), buildGpsLink(), canonicalizeKnownRoads() (+45 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (16): 2026-09-22 (later still) — Pulled independent fleet fixes from "XQuiz", fix(), main(), fix(), main(), is_blocklisted_chunk(), _normalize_for_blocklist(), strip_trailing_signoff() (+8 more)

### Community 5 - "Community 5"
Cohesion: 0.06
Nodes (39): Separator, SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader(), SheetOverlay, SheetTitle (+31 more)

### Community 6 - "Community 6"
Cohesion: 0.08
Nodes (44): ADDRESS_HOMOPHONES, attachBlockNumber(), buildStreetCandidate(), CALLSIGN_SUFFIXES, CANDIDATE_BLOCKLIST, cleanStreet(), cleanWord(), CROSS_LINKERS (+36 more)

### Community 7 - "Community 7"
Cohesion: 0.11
Nodes (16): getDatabase(), DatabaseStorage, DispatchEventDocument, EventLocationUpdate, IStorage, mapEvent(), mapSetting(), SettingDocument (+8 more)

### Community 8 - "Community 8"
Cohesion: 0.07
Nodes (31): App(), AppRouter(), AppErrorBoundary, crashReloadDelayMs(), readCount(), State, Window, writeCount() (+23 more)

### Community 9 - "Community 9"
Cohesion: 0.05
Nodes (39): dependencies, cmdk@^1.1.1, express-rate-limit@^8.7.0, @hookform/resolvers@^5.4.0, input-otp@^1.4.2, @jridgewell/trace-mapping@^0.3.25, lucide-react@^0.453.0, memorystore@^1.6.7 (+31 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (37): devDependencies, autoprefixer@^10.4.20, cross-env@^7.0.3, esbuild@^0.25.0, postcss@^8.4.47, tailwindcss@^3.4.17, @tailwindcss/typography@^0.5.15, @tailwindcss/vite@^4.1.18 (+29 more)

### Community 11 - "Community 11"
Cohesion: 0.07
Nodes (28): CURATED, dictionary, ENDPOINTS, names, outPath, stems, TYPE_ONLY_WORDS, AddressSegment (+20 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (30): isDispatchGroupChat(), deleteTelegramWebhook(), getTelegramCredentials(), handleCheckinsCommand(), handleCheckinTap(), handleTelegramUpdate(), initTelegramAcceptTransport(), noteSeenMember() (+22 more)

### Community 13 - "Community 13"
Cohesion: 0.06
Nodes (30): Capture survives desk updates (2026-10-03, PR fix/capture-survives-updates), Dispatch Monitor — Project Context, Fleet-wide orders (apply to every box — no device specifics here), How to test audio upload, Key commands, NEXT FIRE-UP — OFFICE RETURN (2026-09-21 AM), Pending tasks / next steps, Project overview (+22 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (27): db(), driverBoard(), AcceptedCallRecord, ARRIVAL_RADIUS_M, ARRIVAL_WINDOW_MS, ArrivalStatus, driverFreshness(), DriverLocationPoint (+19 more)

### Community 15 - "Community 15"
Cohesion: 0.12
Nodes (28): ADDRESS_CORRECTIONS, addressSimilarity(), cleanAddress(), clusterEvents(), correctAddressSpelling(), extractAddressFromTranscript(), GENERIC_JUNK_ADDRESSES, haversineKm() (+20 more)

### Community 16 - "Community 16"
Cohesion: 0.11
Nodes (25): checkinAckText(), checkinCallbackData(), CheckinConfig, dailyCheckinMarkup(), dailyCheckinText(), Eligibility, expiryReminderHtml(), ineligibleAcceptText() (+17 more)

### Community 17 - "Community 17"
Cohesion: 0.07
Nodes (27): date-fns@^3.6.0, embla-carousel-react@^8.6.0, ffmpeg-static@^5.2.0, @radix-ui/react-accordion@^1.2.4, @radix-ui/react-navigation-menu@^1.2.6, @radix-ui/react-slot@^1.2.0, @radix-ui/react-toggle-group@^1.1.3, react-hook-form@^7.55.0 (+19 more)

### Community 18 - "Community 18"
Cohesion: 0.10
Nodes (16): Alert, AlertDescription, AlertTitle, alertVariants, HoverCardContent, PopoverContent, Progress, Slider (+8 more)

### Community 19 - "Community 19"
Cohesion: 0.17
Nodes (20): isLikelyRealDispatch(), backfillAddressFromContext(), CONTEXT_MAX_ENTRIES, CONTEXT_MAX_ENTRY_CHARS, ContextAddressResult, hasDispatchSignalWord(), isBarrierText(), isUsableContextEntry() (+12 more)

### Community 20 - "Community 20"
Cohesion: 0.12
Nodes (22): ChatMemberInfo, decideAutoRemoval(), exemptionFor(), ExemptReason, isMissingBanRights(), kickMember(), KickResult, MISSING_RIGHTS_NOTE (+14 more)

### Community 21 - "Community 21"
Cohesion: 0.14
Nodes (22): formatRoster(), formatAge(), removeReplyText(), handleRemoveCommand(), handleWhereCommand(), notifyAdmins(), tgApi(), warnMissingRights() (+14 more)

### Community 22 - "Community 22"
Cohesion: 0.16
Nodes (20): AudioPanel(), AUTO_CAPTURE_KEY, CaptureHealth, isPermissionError(), isStalled(), LAST_FORCED_RELOAD_KEY, MIN_FORCED_RELOAD_GAP_MS, readAutoCapture() (+12 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (20): AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter(), AlertDialogHeader(), AlertDialogOverlay, AlertDialogTitle (+12 more)

### Community 24 - "Community 24"
Cohesion: 0.19
Nodes (21): Get-AppRestartGap(), Get-CaptureStatus(), Limit-LogSize(), Restart-App(), Restart-AppIfDead(), Restart-Whisper(), Set-ServicePriority(), Start-App() (+13 more)

### Community 25 - "Community 25"
Cohesion: 0.11
Nodes (20): confirmLease(), decideLease(), DeskCaptureSummary, HOLDER_IDLE_GRACE_MS, LEASE_IDLE_GRACE_MS, LEASE_RENEW_MS, LEASE_TTL_MS, LeaseDecision (+12 more)

### Community 27 - "Community 27"
Cohesion: 0.13
Nodes (14): express@^5.0.1, vite@^7.3.0, @vitejs/plugin-react@^4.7.0, express, vite, @vitejs/plugin-react, app, http (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.23
Nodes (20): checkinRoster(), checkinsFor(), claimRemoval(), db(), driverEligibility(), findSeenByUsername(), getReminder(), evaluateEligibility() (+12 more)

### Community 29 - "Community 29"
Cohesion: 0.11
Nodes (12): computeGitInfo(), ExecGit, getGitInfo(), GitInfo, resetGitInfoCache(), calls, empty, first (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.12
Nodes (14): DEFAULT_DISTRICTS, SIGNAL_TYPES, applyAddressHomophones(), containsMajorRoad(), ExtractedAddress, setStreetDictionaryNames(), DEFAULT_KEYWORDS, detectKeywords() (+6 more)

### Community 31 - "Community 31"
Cohesion: 0.16
Nodes (10): Get-ChromePath(), Get-TelegramCredentials(), Read-BranchAlertState(), Save-BranchAlertState(), Save-CaptureState(), Send-BranchDriftAlert(), Send-TelegramAlert(), Test-BranchAlertAllowed() (+2 more)

### Community 32 - "Community 32"
Cohesion: 0.21
Nodes (19): client, containsConversationPhrase(), containsNonsensePattern(), containsVideoPhrase(), conversationPhrases, dispatchSignals, hasKeywordSpam(), hasRepetitiveWords() (+11 more)

### Community 33 - "Community 33"
Cohesion: 0.17
Nodes (15): DispatchPayload, UseDispatchBufferOptions, ChunkMeta, CORE_DEFAULTS, CoreConfig, CoreKeyword, CorePayload, CoreStats (+7 more)

### Community 34 - "Community 34"
Cohesion: 0.11
Nodes (18): compilerOptions, allowImportingTsExtensions, baseUrl, esModuleInterop, incremental, jsx, lib, module (+10 more)

### Community 35 - "Community 35"
Cohesion: 0.14
Nodes (15): Command, CommandDialog(), CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator (+7 more)

### Community 36 - "Community 36"
Cohesion: 0.13
Nodes (13): Checkbox, InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot, RadioGroup, RadioGroupItem, SelectContent (+5 more)

### Community 37 - "Community 37"
Cohesion: 0.12
Nodes (16): aliases, components, hooks, lib, ui, utils, rsc, $schema (+8 more)

### Community 38 - "Community 38"
Cohesion: 0.16
Nodes (14): Format-WatchdogBeat(), Get-CaptureOutage(), Get-CaptureOutageDecision(), Get-CaptureStatusRaw(), Get-ChromeAgeSec(), Invoke-CaptureRecoveryStep(), Request-CaptureRecover(), Restart-CaptureBrowser() (+6 more)

### Community 39 - "Community 39"
Cohesion: 0.14
Nodes (7): Get-RegistryKeyChain(), Get-ZeroTabStep(), Set-ChromeCapturePolicy(), Advance(), Restart-CaptureBrowser(), Run-Timeline(), Send-BrowserRestarted()

### Community 40 - "Community 40"
Cohesion: 0.23
Nodes (13): extractJoinedAddress(), extractAddress(), compareHouseNumbers(), convertSpokenDigitRuns(), hasFragmentedHouseNumber(), HouseNumberRelation, normAddr(), sameStreet() (+5 more)

### Community 41 - "Community 41"
Cohesion: 0.16
Nodes (13): HMR, original, PORT, postsFlowing(), repo, require, results, sleep() (+5 more)

### Community 42 - "Community 42"
Cohesion: 0.23
Nodes (12): Restart-App(), Restart-AppIfDead(), Restart-Whisper(), Start-App(), Start-Whisper(), Stop-AppLauncher(), Stop-ProcessOnPort(), Stop-StrayWhisper() (+4 more)

### Community 43 - "Community 43"
Cohesion: 0.16
Nodes (7): Add-Tab(), Get-CaptureStatus(), Get-CaptureStatusRaw(), Restart-CaptureBrowser(), Run-Boot(), Start-Browser(), Step-Server()

### Community 44 - "Community 44"
Cohesion: 0.19
Nodes (12): ADDRESS_HOLD_MS, AudioPanelProps, DetectedEvent, TranscriptEntry, RmsMeter(), RmsMeterProps, hookLeaseRelease(), LeaseState (+4 more)

### Community 45 - "Community 45"
Cohesion: 0.19
Nodes (13): Carousel, CarouselApi, CarouselContent, CarouselContext, CarouselContextProps, CarouselItem, CarouselNext, CarouselOptions (+5 more)

### Community 46 - "Community 46"
Cohesion: 0.19
Nodes (10): DISPATCH_RETRY_HEADER, isTransientDbError(), QueuedDispatch, ReplayOutcome, RETRY_BASE_MS, RETRY_MAX_AGE_MS, RETRY_MAX_MS, TRANSIENT_PATTERNS (+2 more)

### Community 47 - "Community 47"
Cohesion: 0.15
Nodes (4): Get-CaptureRecoveryStep(), Read-CaptureState(), St(), Stop-Process()

### Community 48 - "Community 48"
Cohesion: 0.23
Nodes (10): FormControl, FormDescription, FormFieldContext, FormFieldContextValue, FormItem, FormItemContext, FormItemContextValue, FormLabel (+2 more)

### Community 49 - "Community 49"
Cohesion: 0.27
Nodes (5): DispatchRetryQueue, retryDelayMs(), dispatchRetryQueue(), check(), main()

### Community 50 - "Community 50"
Cohesion: 0.27
Nodes (11): check(), FakeTimer, fireFakeTimers(), flush(), freshWindow(), installFakeTimers(), LockCallback, main() (+3 more)

### Community 51 - "Community 51"
Cohesion: 0.27
Nodes (10): ChartConfig, ChartContainer, ChartContext, ChartContextProps, ChartLegendContent, ChartStyle(), ChartTooltipContent, getPayloadConfigFromPayload() (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.29
Nodes (9): CaptureLockState, getCaptureLockState(), LOCK_REQUEST_TIMEOUT_MS, LockStore, releaseCaptureLock(), request(), stealCaptureLock(), store() (+1 more)

### Community 53 - "Community 53"
Cohesion: 0.20
Nodes (7): AudioCaptureHealth, CHUNK_DURATION_MS, RAW_AUDIO_CONSTRAINTS, SILENCE_RMS, useAudioCapture(), UseAudioCaptureOptions, UseAudioCaptureReturn

### Community 54 - "Community 54"
Cohesion: 0.31
Nodes (8): ensureUploadDir(), registerAudioUploadRoutes(), safeUnlink(), transcribeOptimizedAudio(), upload, getWhisperModel(), transcribeAudio(), WhisperResponse

### Community 55 - "Community 55"
Cohesion: 0.36
Nodes (7): hasDispatchKeyword(), isAddressRejection(), isSameReviewCall(), NEEDS_REVIEW_STATUS, REVIEW_DEDUP_WINDOW_MS, shouldCreateReviewEvent(), sig4

### Community 56 - "Community 56"
Cohesion: 0.31
Nodes (5): Known issues, main(), findFfmpeg(), optimizeAudio(), OptimizeAudioOptions

### Community 57 - "Community 57"
Cohesion: 0.22
Nodes (9): scripts, build, check, dev, optimize-audio, start, whisper:bundle, whisper:setup (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.22
Nodes (4): client, collection, ids, JUNK_PIN

### Community 59 - "Community 59"
Cohesion: 0.32
Nodes (6): app, handler(), http, httpServer, IncomingMessage, init()

### Community 60 - "Community 60"
Cohesion: 0.36
Nodes (7): escapeHtml(), escapeRegExp(), TranscriptEntry, TranscriptFeed(), TranscriptFeedProps, useDispatchBuffer(), detectKeywords()

### Community 61 - "Community 61"
Cohesion: 0.32
Nodes (7): NavigationMenu, NavigationMenuContent, NavigationMenuIndicator, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport

### Community 62 - "Community 62"
Cohesion: 0.25
Nodes (7): maxDuration, buildCommand, functions, api/index.js, outputDirectory, rewrites, version

### Community 63 - "Community 63"
Cohesion: 0.33
Nodes (6): buildPopupContent(), DispatchMap(), DispatchMapProps, DispatchMarker, leaflet@^1.9.4, leaflet

### Community 64 - "Community 64"
Cohesion: 0.29
Nodes (6): dotenv@^16.4.7, dotenv, bySource, coll, hours, since

### Community 65 - "Community 65"
Cohesion: 0.29
Nodes (6): @supabase/supabase-js@^2.49.4, ws@^8.18.0, @supabase/supabase-js, ws, isSupabaseConfigured, supabase

### Community 66 - "Community 66"
Cohesion: 0.29
Nodes (6): Folder Layout, Keeping in Sync, Local Dispatch Monitor + Nexus Dispatch Setup, Ports, Prerequisites, Quick Start

### Community 68 - "Community 68"
Cohesion: 0.33
Nodes (5): Do this on every box (Git Bash), Fleet Post-Pull Runbook — 2026-09-16 update, If something looks wrong, What changed (behavior you will notice), What is NOT in this update

### Community 69 - "Community 69"
Cohesion: 0.40
Nodes (4): Establishing identity on a box (do this, not prose in a tracked file), Fleet Identity — how a device learns who it is, Known devices, The convention

### Community 71 - "Community 71"
Cohesion: 0.67
Nodes (4): Invoke-External(), Invoke-Git(), Invoke-NpmInstall(), Pull-Repo()

## Knowledge Gaps
- **43 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cn()` connect `Community 0` to `Community 1`, `Community 35`, `Community 36`, `Community 5`, `Community 8`, `Community 45`, `Community 48`, `Community 18`, `Community 51`, `Community 23`, `Community 61`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `AudioPanel()` (e.g. with `getCaptureLockState()` and `subscribeCaptureLock()`) actually correct?**
  _`AudioPanel()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.04613807245386193 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Community 1` to `Community 0`, `Community 33`, `Community 35`, `Community 36`, `Community 5`, `Community 8`, `Community 9`, `Community 44`, `Community 45`, `Community 48`, `Community 17`, `Community 18`, `Community 51`, `Community 53`, `Community 23`, `Community 60`, `Community 61`, `Community 63`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.09633418584825235 - nodes in this community are weakly interconnected._
- **Why does `mongodb` connect `Community 3` to `Community 64`, `Community 32`, `Community 9`, `Community 15`, `Community 17`, `Community 58`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.05096153846153846 - nodes in this community are weakly interconnected._