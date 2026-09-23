// Root build file: plugins are declared here, applied in app/build.gradle.kts.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("com.google.devtools.ksp") version "2.0.20-1.0.25" apply false
}

/**
 * Optional redirect of build output away from the source tree.
 *
 * This repo lives under OneDrive on at least one machine. OneDrive holds file
 * handles open while it syncs, so Gradle's "delete the output directory before
 * regenerating it" step fails with `IOException: Unable to delete directory`,
 * usually on the KSP-generated sources. Deleting the directory by hand only
 * works until the next sync touches it, so the fix is to keep build output out
 * of the synced tree entirely.
 *
 * Opt-in and machine-local: set `buildOut` in ~/.gradle/gradle.properties (not
 * in this repo), or pass -PbuildOut=/some/path. Unset — as on Codemagic — the
 * default `build/` layout is used and nothing changes.
 */
providers.gradleProperty("buildOut").orNull?.let { out ->
    allprojects {
        layout.buildDirectory.set(file("$out/${project.name}"))
    }
}
