---
"@theokit/sdk": minor
---

The OAuth ID token is now kept from the token response to the credential file (#821). `exchangeCode`,
`refreshOAuthTokens`, `pollDeviceToken` and `openaiDeviceLogin` return it as `OAuthTokens.idToken` when
the provider sends a non-empty `id_token`, `persistOAuthTokens` writes it as `id_token`, and
`readStoredOAuth` reads it back on `StoredOAuthCredential.id_token`. `ensureFreshCredential` keeps the
stored ID token when a refresh response has none and stores the new one when it has one. It used to be
read only to derive the account id and then dropped, so a consumer that drives the Codex CLI, which reads
the plan and account from the ID token's claims, had to run its own login. A provider that sends no ID
token gets exactly the file it got before. A file that holds an `id_token` is refused by the read schema
of earlier SDK versions, so a store shared with an older reader should stay on one version.
