# Windows Deployment Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a secret-free ZIP that lets a Windows recipient initialise and start the full Docker deployment with double-click scripts.

**Architecture:** Keep the existing Docker Compose production stack unchanged. Add a Windows helper that generates the required per-installation secrets in `.env`, then starts the Compose stack; package the current source tree while explicitly excluding local secrets, dependencies, build artifacts and Git history.

**Tech Stack:** PowerShell 5.1+, Windows batch files, Docker Compose, existing Bun/Docker application.

**Spec:** User request on 2026-08-26: provide a deployment package that can be sent to other people.

## Global Constraints

- Never include `.env`, `server/.env`, `web/.env`, database volumes, generated assets or API keys.
- Do not change production Compose topology or expose private service ports.
- Package must work after extraction on Windows with Docker Desktop installed.

---

### Task 1: Create first-run deployment helpers

**Files:**
- Create: `ops/windows/Initialize-Deployment.ps1`
- Create: `ops/windows/安装并启动.bat`
- Create: `ops/windows/停止服务.bat`
- Create: `ops/windows/查看状态.bat`

**Interfaces:**
- Consumes: `.env.example`, `docker-compose.yml`, Docker Desktop.
- Produces: a per-installation `.env` and a running `docker compose` deployment.

- [ ] **Step 1: Write a first-run script that verifies Docker Compose and creates `.env` only if absent.**
- [ ] **Step 2: Generate random database, object-storage and provider-encryption secrets, then prompt for the bootstrap administrator password without echoing it.**
- [ ] **Step 3: Add batch launchers for start, stop and status.**
- [ ] **Step 4: Run the PowerShell script with `-WhatIf`-equivalent validation paths and inspect generated configuration without printing secrets.**

### Task 2: Create package documentation and archive automation

**Files:**
- Create: `ops/windows/README-部署说明.md`
- Create: `ops/windows/Build-DeploymentPackage.ps1`

**Interfaces:**
- Consumes: repository root and Windows helper files.
- Produces: `交付/无线画布-部署包-<version>.zip`.

- [ ] **Step 1: Document prerequisites, first run, provider configuration, access URL and safe stop/update commands.**
- [ ] **Step 2: Write archive automation with explicit exclusion patterns for secrets, dependency caches, Git data, logs and output archives.**
- [ ] **Step 3: Run the builder and verify the archive listing has required launchers but no excluded sensitive paths.**

### Task 3: Validate recipient-facing delivery

**Files:**
- Verify: generated deployment ZIP.

**Interfaces:**
- Consumes: generated ZIP.
- Produces: evidence that it is complete, secret-free and deployable.

- [ ] **Step 1: Inspect ZIP entries for `docker-compose.yml`, `.env.example`, helper scripts and documentation.**
- [ ] **Step 2: Assert ZIP entries do not contain `.env`, `node_modules`, `.git`, `.worktrees`, build output or logs.**
- [ ] **Step 3: Run project build/tests before delivering the package.**
