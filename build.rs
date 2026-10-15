fn main() {
    println!("cargo:rerun-if-changed=assets/rdsh.rc");
    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|s| s == "windows") {
        // The debug `rdsh` binary needs close to the 1 MiB main-thread stack
        // the Windows linker reserves by default (clap's derived parser
        // dominates the frame), so one extra call frame — `context hook
        // status` re-reading a config — overflows it. Ask for the 8 MiB that
        // the Linux and macOS defaults already provide.
        match std::env::var("CARGO_CFG_TARGET_ENV").as_deref() {
            Ok("msvc") => println!("cargo:rustc-link-arg-bins=/STACK:8388608"),
            Ok("gnu") => println!("cargo:rustc-link-arg-bins=-Wl,--stack,8388608"),
            _ => {}
        }
        embed_resource::compile_for("assets/rdsh.rc", ["rdsh"], embed_resource::NONE)
            .manifest_required()
            .expect("Windows rdsh icon resource compilation failed");
    }
}
