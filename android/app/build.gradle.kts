plugins {
    id("com.android.application")
}

android {
    namespace = "com.xiangqitv.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.xiangqitv.app"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

val webDistDirectory = rootProject.layout.projectDirectory.dir("../web/dist")
val packagedWebAssets = layout.projectDirectory.dir("src/main/assets")

val syncWebAssets by tasks.registering(Sync::class) {
    from(webDistDirectory)
    into(packagedWebAssets)

    doFirst {
        check(webDistDirectory.file("index.html").asFile.isFile) {
            "Web build not found. Run `pnpm --dir ../web build` before building Android."
        }
    }
}

tasks.named("preBuild").configure { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
}
