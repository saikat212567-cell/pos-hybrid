plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")          // Room annotation processing
}

android {
    namespace = "com.example.pos"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.pos"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Injected from gradle properties / CI secrets, never hardcoded in
        // source. Read at runtime as BuildConfig.API_BASE / API_TOKEN.
        buildConfigField("String", "API_BASE",
            "\"${project.findProperty("apiBase") ?: ""}\"")
        buildConfigField("String", "API_TOKEN",
            "\"${project.findProperty("apiToken") ?: ""}\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false        // unsigned debug-style release; sign when you ship
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")

    // Local offline queue
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // Deferred background sync with a "network connected" constraint
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // HTTP to Supabase REST. JSON handled by org.json, which is in the platform.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
}
