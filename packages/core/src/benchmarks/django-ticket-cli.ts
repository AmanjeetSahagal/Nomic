#!/usr/bin/env node

import { parseDjangoTracTicket } from "./github-corpus-collector";

const requests = process.argv.slice(2).map((value) => {
  const separator = value.indexOf("=");
  const number = Number(value.slice(0, separator));
  const mergedAt = value.slice(separator + 1);
  if (!Number.isInteger(number) || number <= 0 || separator < 1 || Number.isNaN(new Date(mergedAt).getTime())) {
    throw new Error(`Expected ticket=mergedAt, received: ${value}`);
  }
  return { number, mergedAt };
});

async function main(): Promise<void> {
  const tickets = [];
  for (const request of requests) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(`https://code.djangoproject.com/ticket/${request.number}`, {
        headers: { "User-Agent": "nomic-corpus-collector" }
      });
      if (response.status !== 429) break;
      await delay(1500 * (attempt + 1));
    }
    if (!response?.ok) throw new Error(`Django Trac ${response?.status ?? "failed"} for ticket #${request.number}`);
    tickets.push(parseDjangoTracTicket(await response.text(), request.number, request.mergedAt));
    await delay(500);
  }
  process.stdout.write(`${JSON.stringify(tickets)}\n`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
