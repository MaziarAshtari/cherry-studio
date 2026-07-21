---
title: Per-assistant context limits restored
category: changed
severity: notice
introduced_in_pr: TBD
date: 2026-07-20
---

## What changed

Assistant model configuration once again includes a context count. Chat requests use the same window as legacy Cherry Studio: the latest `context count + 2` raw messages, including the outgoing user message, then any leading assistant message is removed.

## Why this matters to the user

Users can control how much recent conversation history each assistant sends to a model, including in temporary chats.

## What the user should do

Nothing — migrated context-count values are restored automatically, and assistants without one use the default of 5.
