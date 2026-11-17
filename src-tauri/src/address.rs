pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

pub fn parse(input: &str) -> Result<Endpoint, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("先写 VNC 地址".to_string());
    }

    let (host, port_text) = split_host(text)?;
    let host = if host.is_empty() {
        "localhost".to_string()
    } else {
        host
    };
    let port = match port_text {
        None => 5900,
        Some(text) => parse_port(text)?,
    };
    Ok(Endpoint { host, port })
}

fn split_host(text: &str) -> Result<(String, Option<&str>), String> {
    let bytes = text.as_bytes();
    if bytes[0] == b'[' {
        let end = text.find(']').ok_or("地址里的 [ 没有配对")?;
        let host = text[1..end].trim().to_string();
        let rest = text[end + 1..].trim();
        return Ok((host, if rest.is_empty() { None } else { Some(rest) }));
    }

    let Some(last_colon) = text.rfind(':') else {
        return Ok((text.to_string(), None));
    };
    let host_end = if last_colon > 0 && bytes[last_colon - 1] == b':' {
        last_colon - 1
    } else {
        last_colon
    };
    let first_colon = text.find(':').unwrap();
    if first_colon != host_end {
        return Ok((text.to_string(), None));
    }
    let host = text[..host_end].trim().to_string();
    Ok((host, Some(text[host_end..].trim())))
}

fn parse_port(text: &str) -> Result<u16, String> {
    if !text.starts_with(':') {
        return Err("端口不正确".to_string());
    }
    let literal = text.starts_with("::");
    let number_text = if literal { &text[2..] } else { &text[1..] }.trim();
    if number_text.is_empty() || !number_text.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("端口不正确".to_string());
    }
    let number: u32 = number_text.parse().map_err(|_| "端口不正确".to_string())?;
    let port = if !literal && number < 100 {
        number + 5900
    } else {
        number
    };
    if port == 0 || port > 65535 {
        return Err("端口不正确".to_string());
    }
    Ok(port as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_colon_is_a_literal_port() {
        let endpoint = parse("192.0.2.9::5900").unwrap();
        assert_eq!(endpoint.host, "192.0.2.9");
        assert_eq!(endpoint.port, 5900);
    }

    #[test]
    fn single_colon_below_100_is_a_display() {
        let endpoint = parse("192.0.2.4:5").unwrap();
        assert_eq!(endpoint.port, 5905);
    }

    #[test]
    fn bare_host_uses_display_zero() {
        let endpoint = parse("192.0.2.9").unwrap();
        assert_eq!(endpoint.port, 5900);
    }
}
