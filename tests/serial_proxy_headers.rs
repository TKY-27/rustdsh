use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct ProxyProcess(Child);

impl Drop for ProxyProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn header_values<'a>(headers: &'a str, name: &str) -> Vec<&'a str> {
    headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
        .collect()
}

#[test]
fn connection_options_are_removed_in_both_directions() {
    const WAIT: Duration = Duration::from_secs(30);
    const BODY: &str = "fixture-body";
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let upstream_address = listener.local_addr().unwrap();
    let upstream = thread::spawn(move || {
        let deadline = Instant::now() + WAIT;
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "upstream connection timed out");
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("upstream accept: {error}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        stream.set_write_timeout(Some(WAIT)).unwrap();
        let mut reader = BufReader::new(&stream);
        let mut request = String::new();
        while !request.ends_with("\r\n\r\n") {
            assert!(reader.read_line(&mut request).unwrap() > 0);
            assert!(request.len() < 16 * 1024);
        }
        write!(
            stream,
            "HTTP/1.1 200 OK\r\n\
             Connection: X-Response-One\r\n\
             Connection: close, \tX-Response-Two , x-response-three\r\n\
             X-Response-One: hop-one\r\n\
             X-Response-Two: hop-two\r\n\
             X-Response-Three: hop-three\r\n\
             X-End-To-End: preserved\r\n\
             Set-Cookie: first=1\r\n\
             Set-Cookie: second=2\r\n\
             Content-Length: {}\r\n\r\n{BODY}",
            BODY.len()
        )
        .unwrap();
        request
    });

    let mut proxy = ProxyProcess(
        Command::new(env!("CARGO_BIN_EXE_rdsh"))
            .args([
                "--language",
                "en",
                "serial-proxy",
                "--upstream",
                &format!("http://{upstream_address}"),
                "--port",
                "0",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stderr = proxy.0.stderr.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some((_, address)) = line.split_once("serial-proxy listening on http://") {
                let _ = sender.send(address.split_whitespace().next().unwrap().to_string());
            }
        }
    });
    let address: SocketAddr = receiver.recv_timeout(WAIT).unwrap().parse().unwrap();
    let mut client = TcpStream::connect_timeout(&address, WAIT).unwrap();
    client.set_read_timeout(Some(WAIT)).unwrap();
    client.set_write_timeout(Some(WAIT)).unwrap();
    write!(
        client,
        "GET /headers HTTP/1.1\r\n\
         Host: {address}\r\n\
         Connection: X-Request-One\r\n\
         Connection: close, \tX-Request-Two , x-request-three\r\n\
         X-Request-One: hop-one\r\n\
         X-Request-Two: hop-two\r\n\
         X-Request-Three: hop-three\r\n\
         Authorization: Bearer Fixture-Key\r\n\
         X-End-To-End: preserved\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    let request = upstream.join().unwrap();
    let (response_headers, body) = response.split_once("\r\n\r\n").unwrap();
    assert!(response_headers.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(body, BODY);
    assert_eq!(
        header_values(&request, "authorization"),
        ["Bearer Fixture-Key"]
    );
    assert_eq!(header_values(&request, "x-end-to-end"), ["preserved"]);
    assert_eq!(
        header_values(response_headers, "x-end-to-end"),
        ["preserved"]
    );
    assert_eq!(
        header_values(response_headers, "set-cookie"),
        ["first=1", "second=2"]
    );
    let mut forwarded = Vec::new();
    for (direction, headers) in [
        ("request", request.as_str()),
        ("response", response_headers),
    ] {
        for suffix in ["one", "two", "three"] {
            let name = format!("x-{direction}-{suffix}");
            if !header_values(headers, &name).is_empty() {
                forwarded.push(name);
            }
        }
    }
    assert!(
        forwarded.is_empty(),
        "forwarded connection fields: {forwarded:?}"
    );
}
