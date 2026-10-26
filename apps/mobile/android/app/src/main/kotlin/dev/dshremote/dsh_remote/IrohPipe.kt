package dev.dshremote.dsh_remote

import android.content.Context

/** Android hooks of the native pipe (apps/mobile/native/dshr_pipe, src/ffi.rs). Dart calls the pipe itself through dart:ffi. */
object IrohPipe {
    init {
        System.loadLibrary("dshr_pipe")
    }

    /** Hands the JavaVM and application context to native code once, for iroh's interface monitor. */
    @JvmStatic
    external fun nativeInit(context: Context)
}
