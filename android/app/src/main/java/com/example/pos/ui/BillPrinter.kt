package com.example.pos.ui

import android.content.Context
import android.content.Intent
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import java.io.File

/**
 * Printing and sharing a bill.
 *
 * The layouts live in the Worker and arrive here as finished HTML. A WebView
 * renders it and Android's own PrintManager takes it from there, which buys three
 * things for almost no code: real printing to any printer the OS knows about
 * (including a USB or Bluetooth thermal roll), "Save as PDF" as a built-in
 * destination, and the print preview. Building a PdfDocument by hand would mean
 * re-implementing the layouts in Kotlin — a second copy of a legal document,
 * drifting from the first.
 *
 * The WebView loads a string and is never pointed at the network, so no
 * JavaScript is enabled and nothing external can be fetched.
 */
object BillPrinter {

    /**
     * Render HTML and hand it to the system print dialog.
     *
     * The WebView must be kept referenced until printing starts — a local
     * variable would be collected mid-render and the job would silently produce
     * a blank page. That is what `held` is for.
     */
    fun print(context: Context, html: String, jobName: String = "Bill") {
        val web = WebView(context)
        web.settings.javaScriptEnabled = false

        web.webViewClient = object : WebViewClient() {
            // A bill is self-contained. Refuse any navigation so a stray link or
            // an injected URL cannot turn the print view into a browser.
            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?,
            ): Boolean = true

            override fun onPageFinished(view: WebView, url: String?) {
                val manager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
                val adapter = view.createPrintDocumentAdapter(jobName)

                manager.print(
                    jobName,
                    adapter,
                    // The bill's own CSS sets @page size for 58mm, 80mm or A4, so
                    // the media size is left to the user's printer rather than
                    // being forced here. Forcing A4 would pad a thermal roll.
                    PrintAttributes.Builder()
                        .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
                        .build()
                )
                held = null
            }
        }

        held = web
        web.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    /** Keeps the WebView alive until onPageFinished; see the note above. */
    private var held: WebView? = null

    /**
     * Share the bill through the system share sheet.
     *
     * This is how "send it on WhatsApp" works with no WhatsApp-specific code: the
     * sheet lists whatever the user has installed. The file goes to cacheDir and
     * is exposed through a FileProvider, because a raw file:// URI thrown at
     * another app raises FileUriExposedException on anything since Android 7.
     */
    fun share(context: Context, html: String, invoiceNo: String?) {
        val name = "bill-${(invoiceNo ?: "draft").replace(Regex("[^A-Za-z0-9-]"), "-")}.html"
        val dir = File(context.cacheDir, "bills").apply { mkdirs() }
        val file = File(dir, name).apply { writeText(html) }

        val uri = FileProvider.getUriForFile(
            context, "${context.packageName}.fileprovider", file
        )

        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/html"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, invoiceNo ?: "Bill")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        context.startActivity(Intent.createChooser(intent, "Share bill"))
    }
}
