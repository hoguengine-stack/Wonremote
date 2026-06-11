use turbojpeg::{Compressor, Image, PixelFormat, Subsamp};

fn main() {
    let width = 32;
    let height = 32;
    let pixels = vec![0u8; width * height * 3]; // RGB888

    let image = Image {
        pixels: &pixels[..],
        width,
        pitch: width * 3,
        height,
        format: PixelFormat::RGB,
    };

    let mut compressor = Compressor::new().unwrap();
    let _ = compressor.set_quality(85);
    let _ = compressor.set_subsamp(Subsamp::Sub2x2); // YUV 420

    match compressor.compress_to_vec(image) {
        Ok(buf) => {
            println!("Compression success! Compressed size: {} bytes", buf.len());
        }
        Err(e) => {
            eprintln!("Compression error: {:?}", e);
        }
    }
}
