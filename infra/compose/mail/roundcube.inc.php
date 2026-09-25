<?php
// Веб-почта «Портала КЧС» (ADR-0150). Roundcube ходит к почтовому серверу внутри сети
// развёртывания: с самоподписанным сертификатом закрытого контура проверка имени
// отключена только здесь. С настоящим сертификатом домена Комитета эти строки убирают.
$config['product_name'] = 'Почта — Портал КЧС';
$config['imap_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]];
$config['smtp_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]];
// Вход — адресом ящика и паролем для почты из профиля сотрудника
$config['login_autocomplete'] = 0;
$config['language'] = 'ru_RU';
$config['timezone'] = 'Asia/Dushanbe';
