{
  "targets": [
    {
      "target_name": "scannative",
      "sources": ["scan.cc"],
      "cflags_cc": ["-O3", "-std=c++17"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_OPTIMIZATION_LEVEL": "3",
        "OTHER_CPLUSPLUSFLAGS": ["-fno-exceptions", "-fno-rtti"]
      }
    }
  ]
}
