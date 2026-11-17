---
name: harden
description: Stress-test plans and changes
metadata:
  evot:
    requires:
      bins: [git]
    command:
      schema_version: 1
      description: Stress-test the previous plan, current changes, or a target
      usage: /harden [changes | <target>]
      arguments: [changes, "<target>"]
---

# Harden

Use the previous plan; if none exists, inspect local git changes before asking for a subject.
