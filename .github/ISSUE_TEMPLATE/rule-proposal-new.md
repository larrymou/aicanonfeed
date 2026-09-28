---
name: Rule Proposal · New
about: Add a new rule item to an existing group
title: "[RULE] new "
labels: proposal
assignees: ''
---

## Proposal Type

new

## Category

<!-- model-releases / research / industry / policy / tools-oss -->

model-releases

## Target Group

<!-- Group number to add the item to (e.g., 3). Existing groups only; MVP does not create new groups. -->

## Rule Text

<!-- English. Actionable inclusion determination. -->
<!-- Good: "Include items that announce a new AI model from the model owner with an official announcement link" -->
<!-- Bad: "Good AI news should be included" -->

## Evidence Contract

<!-- Required for new rules. How can the editor verify the inclusion criteria? -->
<!-- Lines: requires_evidence: token, token   (ALL must hold) -->
<!--        evidence_any: branch1; branch2    (ANY branch may satisfy; tokens in a branch comma-separated) -->
<!-- -->
<!-- RSS-observable tokens (usable today): -->
<!--   repo_link, code_host_link, link, linkHost, title, summary, summary_raw, pubDate, sourceName -->
<!-- Page-fact tokens (need a page fetcher the editor does not have yet): -->
<!--   official_domain, page_author, page_content, page_version_label -->
<!-- -->
<!-- The community may declare either kind. The engine enforces what you ratify. -->
<!-- Page-fact-only contracts will hard-deny matches until a fetcher exists. -->
<!-- Example (repo link OR official page): evidence_any: repo_link; official_domain -->
<!-- Example (only title/summary checkable): evidence_any: title; summary -->
