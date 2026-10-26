import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Log in to DSH Web through the phone-side tunnel port the way the WebView
/// does (launch token → 303 + DSH's cookie → page) and return the page.
Future<String> webLogin(int port, String tokenQuery) async {
  final client = HttpClient();
  try {
    Future<HttpClientResponse> get(String target, {String? cookie}) async {
      final request = await client.getUrl(Uri.parse('http://127.0.0.1:$port$target'));
      request.followRedirects = false;
      request.headers.set('origin', 'http://127.0.0.1:$port');
      if (cookie != null) request.headers.set('cookie', cookie);
      return request.close();
    }

    final anonymous = await get('/');
    expect(anonymous.statusCode, 401, reason: 'DSH Web wants its owner cookie');
    await anonymous.drain<void>();
    final login = await get('/?$tokenQuery');
    expect(login.statusCode, 303);
    final cookie = login.headers.value('set-cookie')!.split(';').first;
    await login.drain<void>();
    final page = await get('/', cookie: cookie);
    expect(page.statusCode, 200);
    return await page.transform(utf8.decoder).join();
  } finally {
    client.close();
  }
}
