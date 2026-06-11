$cmake_path = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"
$nasm_path = "$PSScriptRoot\nasm-2.16.03"
$env:PATH = "$cmake_path;$nasm_path;" + $env:PATH
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release
