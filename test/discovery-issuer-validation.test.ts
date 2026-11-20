import test from 'node:test'
import assert from 'node:assert/strict'
import * as client from '../src/index.js'

test('discovery validates the discovered issuer before delivering a configuration', async () => {
  const issuer = new URL('https://op.example.com')

  // In-memory discovery documents served in sequence, no network involved.
  const documents: unknown[] = [
    // 1. issuer matches the configured one
    { issuer: issuer.href, token_endpoint: `${issuer.origin}/token` },
    // 2. issuer declaration missing
    { token_endpoint: `${issuer.origin}/token` },
    // 3. issuer does not match the configured one
    { issuer: 'https://impostor.example.com/' },
    // 4. issuer declaration is not a valid URL
    { issuer: 'not a url' },
    // 5. valid document again, proving earlier rejections are not sticky
    { issuer: issuer.href, token_endpoint: `${issuer.origin}/token` },
  ]

  const customFetch = async () => {
    const document = documents.shift()
    assert.notEqual(document, undefined, 'unexpected additional fetch')
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const discover = () =>
    client.discovery(issuer, 'client_id', 'client_secret', undefined, {
      // @ts-ignore
      [client.customFetch]: customFetch,
    })

  // 1. A matching document yields a configuration exposing the declared issuer.
  const config = await discover()
  assert.equal(config.serverMetadata().issuer, issuer.href)

  // 2. A document without an issuer declaration is rejected as such.
  await assert.rejects(
    discover(),
    (err: any) => {
      assert.equal(err.name, 'ClientError')
      assert.equal(err.code, 'OAUTH_MISSING_SERVER_METADATA')
      assert.equal(err.cause?.body, undefined)
      return true
    },
    'missing issuer must reject with a distinguishable error',
  )

  // 3. A document declaring a different issuer is rejected as a mismatch.
  await assert.rejects(
    discover(),
    (err: any) => {
      assert.equal(err.name, 'ClientError')
      assert.equal(err.code, 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED')
      // diagnostics must not leak the discovered document's content
      assert.equal(err.cause?.body, undefined)
      assert.ok(!JSON.stringify(err.cause).includes('impostor.example.com'))
      return true
    },
    'mismatched issuer must reject with a distinguishable error',
  )

  // 4. An issuer declaration that does not parse as a URL is rejected as such.
  await assert.rejects(
    discover(),
    (err: any) => {
      assert.equal(err.name, 'ClientError')
      assert.equal(err.code, 'OAUTH_INVALID_SERVER_METADATA')
      assert.equal(err.cause?.body, undefined)
      return true
    },
    'unparseable issuer must reject with a distinguishable error',
  )

  // 5. The previous rejections do not prevent a later valid document from
  // succeeding for the same caller.
  const recovered = await discover()
  assert.equal(recovered.serverMetadata().issuer, issuer.href)

  assert.equal(documents.length, 0, 'all queued documents were consumed')
})
