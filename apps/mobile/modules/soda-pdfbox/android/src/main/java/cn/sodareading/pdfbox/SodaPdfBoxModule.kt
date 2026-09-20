package cn.sodareading.pdfbox

import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class SodaPdfBoxModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SodaPdfBox")

    AsyncFunction("extractText") { uri: String ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("Android context is unavailable")
      PDFBoxResourceLoader.init(context)
      val path = if (uri.startsWith("file://")) URI(uri).path else uri
      val file = File(path)
      if (!file.exists()) throw IllegalArgumentException("PDF file does not exist")
      PDDocument.load(file).use { document ->
        if (document.isEncrypted) throw IllegalArgumentException("Encrypted PDF is not supported")
        val text = PDFTextStripper().getText(document).trim()
        if (text.length < 100) {
          throw IllegalArgumentException("PDF has too little extractable text; scanned PDFs need OCR")
        }
        text
      }
    }
  }
}
