use windows::core::{Error, Result};
use windows::Win32::Foundation::E_INVALIDARG;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_MODE_ROTATION, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_ROTATE180,
    DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90, DXGI_MODE_ROTATION_UNSPECIFIED,
};

pub fn orient_duplication_bgra(
    source: Vec<u8>,
    surface_width: usize,
    surface_height: usize,
    display_width: usize,
    display_height: usize,
    rotation: DXGI_MODE_ROTATION,
) -> Result<Vec<u8>> {
    let rotated =
        rotation == DXGI_MODE_ROTATION_ROTATE90 || rotation == DXGI_MODE_ROTATION_ROTATE270;
    let valid_dimensions = if rotated {
        surface_width == display_height && surface_height == display_width
    } else {
        surface_width == display_width && surface_height == display_height
    };
    if !valid_dimensions || source.len() != surface_width * surface_height * 4 {
        return Err(Error::new(
            E_INVALIDARG,
            "DXGI surface/display size mismatch".into(),
        ));
    }
    if rotation == DXGI_MODE_ROTATION_IDENTITY || rotation == DXGI_MODE_ROTATION_UNSPECIFIED {
        return Ok(source);
    }
    if !rotated && rotation != DXGI_MODE_ROTATION_ROTATE180 {
        return Err(Error::new(
            E_INVALIDARG,
            "Unsupported DXGI output rotation".into(),
        ));
    }

    let mut output = vec![0u8; source.len()];
    for y in 0..display_height {
        for x in 0..display_width {
            let (source_x, source_y) = if rotation == DXGI_MODE_ROTATION_ROTATE90 {
                (y, surface_height - 1 - x)
            } else if rotation == DXGI_MODE_ROTATION_ROTATE180 {
                (surface_width - 1 - x, surface_height - 1 - y)
            } else {
                (surface_width - 1 - y, x)
            };
            let source_offset = (source_y * surface_width + source_x) * 4;
            let output_offset = (y * display_width + x) * 4;
            output[output_offset..output_offset + 4]
                .copy_from_slice(&source[source_offset..source_offset + 4]);
        }
    }
    Ok(output)
}
