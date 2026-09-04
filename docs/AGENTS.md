# BookForgeAI — Agent Specification

| Agent | Output |
|---|---|
| Discover | Book brief |
| Research | Research library |
| Map | Knowledge/story map |
| Visual Canon | Asset registry |
| Asset Designer | Reference package |
| Architect | Book architecture |
| Design | Design specification |
| Outline | Detailed outline |
| Author | Chapter |
| Scene Composer | Scene specification |
| Image Director | Image specification |
| Image Generator | Artwork |
| Visual QA | Visual QA result |
| Critics | Critiques |
| Diagnosis | Revision tasks |
| Rewriter | Revised content |
| Editor | Edited manuscript |
| Copy Editor | Clean manuscript |
| Continuity | Continuity report |
| Layout | Page model |
| Proof | PDF proof report |
| Publisher | Published edition |

Every agent follows **READ → REASON → VALIDATE → WRITE ARTIFACT → REPORT**.

Use configurable model routing. Do not hard-code a model name into business logic.

Canonical project facts live in structured project data, not hidden conversational memory.
