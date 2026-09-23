package com.example.pos.net

import com.example.pos.net.PosApi.SaleVerdict
import org.junit.Assert.assertEquals
import org.junit.Test

class PosApiTest {
    @Test fun `new sale success`() {
        assertEquals(SaleVerdict.STORED, PosApi.classifySaleResponse(201, """{"ok":true}"""))
    }

    @Test fun `duplicate success`() {
        assertEquals(SaleVerdict.STORED, PosApi.classifySaleResponse(200, """{"ok":true,"duplicate":true}"""))
    }

    @Test fun `duplicate success trailing newline`() {
        assertEquals(SaleVerdict.STORED, PosApi.classifySaleResponse(200, "{\"ok\":true,\"duplicate\":true}\n"))
    }

    @Test fun `unrecognised 2xx captive portal retry`() {
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(200, "<html>login</html>"))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(200, ""))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(200, """{}"""))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(200, """{"ok":false}"""))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(200, """{"ok":true}""")) // missing duplicate flag
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(200, """{"ok":true,"duplicate":false}"""))
    }

    @Test fun `other 2xx retry`() {
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(204, ""))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(299, "captive page"))
    }

    @Test fun `stock write-race retry`() {
        // The exact body the server sends for a CHECK constraint failure (batch rollback).
        val body = """{"error":"stock changed during the sale, retry","retryable":true}"""
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(409, body))
        // Extra fields ignored.
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(409, """{"error":"foo","retryable":true,"detail":"x"}"""))
        // Whitespace variation.
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(409, " {\"error\":\"race\", \"retryable\": true } "))
    }

    @Test fun `insufficient stock permanent rejection`() {
        // The 409 InsufficientStock case (no retryable flag). Exact body from server.
        val body = """{"error":"insufficient stock for p1, 2 available","product":"p1","available":2}"""
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(409, body))
        // Retryable absent.
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(409, """{"error":"stock gone"}"""))
        // retryable false.
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(409, """{"retryable":false}"""))
    }

    @Test fun `bad payload permanent rejection`() {
        // Any other 4xx is permanent.
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(400, """{"error":"malformed json"}"""))
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(401, "unauthorized"))
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(403, ""))
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(422, """{"details":[]}"""))
        assertEquals(SaleVerdict.PERMANENT, PosApi.classifySaleResponse(499, "something"))
    }

    @Test fun `5xx and weird codes retry`() {
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(500, "internal"))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(502, "bad gateway"))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(0, "")) // network-level failure
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(999, ""))
        assertEquals(SaleVerdict.RETRY, PosApi.classifySaleResponse(-1, ""))
    }
}
