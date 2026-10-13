#![forbid(unsafe_code)]
//! wardrobe — the process harness (the logic lives in the library so
//! tests can drive it in-process).

use ferrite_app::{app_main, AppContext, FerriteApp};

struct App;

impl FerriteApp for App {
    fn run(ctx: AppContext) -> impl std::future::Future<Output = std::io::Result<()>> + Send {
        wardrobe::run(ctx)
    }
}

fn main() {
    app_main::<App>()
}
