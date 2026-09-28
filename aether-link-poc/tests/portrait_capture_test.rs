#[path = "../src/capture_orientation.rs"]
mod capture_orientation;

use capture_orientation::orient_duplication_bgra;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_ROTATE180, DXGI_MODE_ROTATION_ROTATE270,
    DXGI_MODE_ROTATION_ROTATE90,
};

fn pixel_ids(ids: &[u8]) -> Vec<u8> {
    ids.iter().flat_map(|id| [*id, 0, 0, 255]).collect()
}

#[test]
fn duplication_frame_matches_display_orientation_before_tile_encoding() {
    let ninety = orient_duplication_bgra(
        pixel_ids(&[2, 4, 6, 1, 3, 5]), 3, 2, 2, 3, DXGI_MODE_ROTATION_ROTATE90,
    )
    .unwrap();
    let two_seventy = orient_duplication_bgra(
        pixel_ids(&[5, 3, 1, 6, 4, 2]), 3, 2, 2, 3, DXGI_MODE_ROTATION_ROTATE270,
    )
    .unwrap();
    let flipped = orient_duplication_bgra(
        pixel_ids(&[6, 5, 4, 3, 2, 1]), 3, 2, 3, 2, DXGI_MODE_ROTATION_ROTATE180,
    )
    .unwrap();
    let expected = pixel_ids(&[1, 2, 3, 4, 5, 6]);
    assert_eq!(ninety, expected);
    assert_eq!(two_seventy, expected);
    assert_eq!(flipped, expected);
    assert_eq!(
        orient_duplication_bgra(expected.clone(), 3, 2, 3, 2, DXGI_MODE_ROTATION_IDENTITY)
            .unwrap(),
        expected
    );
    assert!(orient_duplication_bgra(expected, 3, 2, 2, 3, DXGI_MODE_ROTATION_IDENTITY).is_err());
}
