use crate::base::error::Result;

pub fn logout() -> Result<()> {
    super::clear_auth()?;
    let cache_path = super::models_cache_path()?;
    if cache_path.exists() {
        std::fs::remove_file(&cache_path)?;
    }
    Ok(())
}
