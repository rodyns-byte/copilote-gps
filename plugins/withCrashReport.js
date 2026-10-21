// Version de test : si l'application plante, la cause s'affiche au lancement suivant, avec un bouton « Partager ».
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('expo/config-plugins');

const KOTLIN = (pkg) => `package ${pkg}

import android.app.Activity
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File

/** Enregistre la cause des plantages pour l'afficher au lancement suivant. */
object CrashReport {
  private fun file(c: Context) = File(c.filesDir, "dernier_plantage.txt")
  private fun prefs(c: Context) = c.getSharedPreferences("crash_report", Context.MODE_PRIVATE)

  fun install(c: Context) {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { t, e ->
      try { file(c).writeText("Plantage (Java/Kotlin) dans « \${t.name} »\\n\\n" + android.util.Log.getStackTraceString(e)) } catch (_: Throwable) {}
      previous?.uncaughtException(t, e)
    }
  }

  /** Plantages natifs (C++) : Android 11+ garde la raison de la dernière fermeture. */
  private fun nativeCrash(c: Context): String? {
    if (Build.VERSION.SDK_INT < 30) return null
    val am = c.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val info = am.getHistoricalProcessExitReasons(null, 0, 1).firstOrNull() ?: return null
    if (info.reason != ApplicationExitInfo.REASON_CRASH_NATIVE && info.reason != ApplicationExitInfo.REASON_CRASH) return null
    val seen = prefs(c).getLong("seen", 0)
    if (info.timestamp <= seen) return null
    prefs(c).edit().putLong("seen", info.timestamp).apply()
    val trace = try {
      info.traceInputStream?.use { s ->
        // Le rapport natif est binaire : on garde les morceaux de texte (bibliothèques, fonctions).
        String(s.readBytes(), Charsets.ISO_8859_1).split(Regex("[^\\\\x20-\\\\x7e]+")).filter { it.length >= 6 }.take(120).joinToString("\\n")
      }
    } catch (_: Throwable) { null }
    val kind = if (info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) "natif" else "Java"
    return "Plantage \$kind (Android \${Build.VERSION.RELEASE}, \${Build.MANUFACTURER} \${Build.MODEL})\\n\${info.description ?: ""}\\n\\n\${trace ?: ""}"
  }

  fun pending(c: Context): String? {
    val f = file(c)
    if (f.exists()) return f.readText()
    return nativeCrash(c)?.also { f.writeText(it) }
  }

  fun clear(c: Context) { file(c).delete() }
}

class CrashActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val text = CrashReport.pending(this)
    if (text == null) {
      startActivity(Intent(this, MainActivity::class.java).apply { intent?.extras?.let { putExtras(it) } })
      finish()
      return
    }
    val pad = (16 * resources.displayMetrics.density).toInt()
    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 3, pad, pad) }
    root.addView(TextView(this).apply { textSize = 20f; setTypeface(null, Typeface.BOLD); this.text = "Copilote GPS a planté" })
    root.addView(TextView(this).apply { textSize = 15f; setPadding(0, pad / 2, 0, pad / 2); this.text = "Touchez « Partager » et envoyez ce texte (par exemple par e-mail à vous-même, puis collez-le à Claude)." })
    root.addView(Button(this).apply {
      this.text = "Partager"
      setOnClickListener {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Partager le rapport"))
      }
    })
    root.addView(Button(this).apply {
      this.text = "Effacer et fermer (puis rouvrez l'application)"
      setOnClickListener {
        CrashReport.clear(this@CrashActivity)
        finishAndRemoveTask()
        Runtime.getRuntime().exit(0)
      }
    })
    root.addView(ScrollView(this).apply {
      addView(TextView(this@CrashActivity).apply { textSize = 11f; typeface = Typeface.MONOSPACE; setTextIsSelectable(true); this.text = text })
    })
    setContentView(root)
  }
}
`;

module.exports = (config) => {
  const pkg = config.android.package;
  config = withDangerousMod(config, ['android', async (c) => {
    const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/java', ...pkg.split('.'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CrashReport.kt'), KOTLIN(pkg));
    return c;
  }]);
  config = withMainApplication(config, (c) => {
    let s = c.modResults.contents;
    if (!s.includes('CrashReport')) {
      // Tout au début, et on ne charge pas React Native tant qu'un plantage n'a pas été lu.
      s = s.replace('    super.onCreate()\n', '    super.onCreate()\n    CrashReport.install(this)\n    if (CrashReport.pending(this) != null) return\n');
    }
    c.modResults.contents = s;
    return c;
  });
  return withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application[0];
    app.activity = app.activity ?? [];
    if (!app.activity.some((a) => a.$['android:name'] === '.CrashActivity')) {
      // L'icône de l'application ouvre d'abord CrashActivity, qui passe aussitôt à MainActivity s'il n'y a pas eu de plantage.
      const main = app.activity.find((a) => a.$['android:name'] === '.MainActivity');
      const isLauncher = (f) => (f.action ?? []).some((x) => x.$['android:name'] === 'android.intent.action.MAIN');
      const launcher = (main['intent-filter'] ?? []).filter(isLauncher);
      main['intent-filter'] = (main['intent-filter'] ?? []).filter((f) => !isLauncher(f));
      app.activity.push({ $: { 'android:name': '.CrashActivity', 'android:exported': 'true', 'android:theme': '@android:style/Theme.Material.Light.NoActionBar' }, 'intent-filter': launcher });
    }
    return c;
  });
};
