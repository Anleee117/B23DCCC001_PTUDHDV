# Lab 3 - Kết nối và duy trì kết nối giữa các service

Hệ thống thanh toán học phí gồm hai service Node.js/Express, dữ liệu lưu trong bộ nhớ:

- **Fee Service** (cổng 4001): xem công nợ và tạo lệnh thanh toán, gọi sang ngân hàng để trừ tiền.
- **Ngân hàng giả lập** (cổng 4002): nhận lệnh trừ tiền, hỗ trợ `Idempotency-Key`, có thể giả lập lỗi bằng biến môi trường.

## 1. Cấu trúc thư mục

```
lab3/
  bank.js
  fee.js
  package.json
  load.js
  postman/
    scenario1a-bank-down.postman_collection.json
    scenario1b-bank-up.postman_collection.json
    scenario2-slow-bank.postman_collection.json
    scenario3-keep-alive.postman_collection.json
    scenario4a-drop.postman_collection.json
    scenario4b-fail.postman_collection.json
    scenario4c-rejected.postman_collection.json
```

| File | Vai trò |
|---|---|
| `bank.js` | Ngân hàng giả lập |
| `fee.js` | Fee Service |
| `postman/*.json` | Mỗi file là bộ test Postman cho một tình huống |
| `load.js` | Script đo bằng Node, không bắt buộc, có thể bỏ nếu chỉ dùng Postman CLI |

## 2. Cài đặt

Yêu cầu Node.js từ v18 và Postman CLI.

```
cd lab3
npm install
postman login --with-api-key <API_KEY_CUA_BAN>
```

## 3. Cách chạy

Mở 3 cửa sổ terminal:

- **T1:** chạy ngân hàng (`bank.js`)
- **T2:** chạy Fee Service (`fee.js`)
- **T3:** chạy Postman CLI, đứng trong thư mục `lab3/postman`

Biến môi trường của ngân hàng đặt theo hệ điều hành:

| Hệ điều hành | Ví dụ |
|---|---|
| PowerShell | `$env:DELAY_MS=5000; node bank.js` |
| CMD | `set DELAY_MS=5000 && node bank.js` |
| Mac/Linux | `DELAY_MS=5000 node bank.js` |

Biến đã đặt ở lần chạy trước phải được xóa (hoặc mở terminal mới) khi chạy tình huống không cần biến đó.

**Quy tắc chung:** mỗi lần đổi tình huống, tắt (Ctrl+C) và chạy lại cả ngân hàng lẫn Fee Service. Nếu chỉ khởi động lại một bên, bộ đếm mã lệnh P1, P2... bị lặp, ngân hàng trả lại giao dịch cũ theo `Idempotency-Key` và kết quả sẽ sai.

### Tình huống 1 - Ngân hàng tắt, rồi bật lại

1. T2: `node fee.js` (không chạy ngân hàng).
2. T3: `postman collection run scenario1a-bank-down.postman_collection.json`
3. T1: `node bank.js` (không khởi động lại Fee Service).
4. T3: `postman collection run scenario1b-bank-up.postman_collection.json`
5. Kiểm tra `BANK_URL`: khởi động Fee Service với `BANK_URL=http://localhost:4999`, tắt ngân hàng, chạy lại `scenario1a`. Kết quả phải giống bước 2.

### Tình huống 2 - Ngân hàng chậm

1. T1: `DELAY_MS=5000 node bank.js`
2. T2: `node fee.js`
3. T3: `postman collection run scenario2-slow-bank.postman_collection.json`

### Tình huống 3 - Duy trì kết nối

1. T1: `node bank.js`
2. T2: `node fee.js`
3. T3: `postman collection run scenario3-keep-alive.postman_collection.json`

Mất khoảng 10 giây vì có đoạn chờ nhàn rỗi 6 giây.

### Tình huống 4a - Đứt kết nối sau khi đã trừ tiền

1. T1: `DROP_RATE=0.3 node bank.js`
2. T2: `node fee.js`
3. T3: `postman collection run scenario4a-drop.postman_collection.json`

### Tình huống 4b - Lỗi 500 tạm thời

1. T1: `FAIL_RATE=0.3 node bank.js`
2. T2: `node fee.js`
3. T3: `postman collection run scenario4b-fail.postman_collection.json`

### Tình huống 4c - Bị từ chối vì vượt hạn mức

1. T1: `node bank.js`
2. T2: `node fee.js`
3. T3: `postman collection run scenario4c-rejected.postman_collection.json`

Sau mỗi lần chạy, nhìn dòng `assertions` ở cuối: cột `failed` phải bằng 0.

## 4. Giải thích cách làm

### 4.1. Quy ước kết quả thanh toán

Fee Service phân loại kết quả từ ngân hàng theo câu hỏi: "tiền đã bị trừ chưa?"

| Tình trạng | HTTP | status | Lý do |
|---|---|---|---|
| Ngân hàng xác nhận đã trừ | 201 | PAID | Chắc chắn đã trừ |
| Ngân hàng từ chối (400, 402) | giữ mã của ngân hàng | FAILED | Ngân hàng nói rõ là không trừ |
| Không kết nối được | 503 | FAILED | Request chưa tới ngân hàng nên chắc chắn chưa trừ |
| Hết thời gian chờ hoặc đứt kết nối khi đang chờ | 504 | PENDING | Không biết ngân hàng đã trừ hay chưa |

Điểm mấu chốt: **504/PENDING nghĩa là "không biết"**, không phải "thất bại". Vì vậy công nợ không giảm và lệnh không bị coi là FAILED.

### 4.2. Idempotency-Key: nền tảng để thử lại an toàn

Mỗi lệnh thanh toán có `paymentId` (P1, P2...). Fee Service dùng chính `paymentId` làm cả `reference` và `Idempotency-Key` khi gọi ngân hàng. Ngân hàng nhận lại cùng một khóa thì trả lại giao dịch cũ mà không trừ thêm.

Nhờ đó, khi không biết lần gọi trước đã trừ tiền chưa (đứt kết nối, hết thời gian), Fee Service có thể gọi lại cùng khóa mà không sợ trừ hai lần. Đây là cách đáp ứng quy tắc "không bao giờ trừ tiền hai lần cho một lệnh".

### 4.3. Tình huống 1 - Ngân hàng không kết nối được

**Vấn đề:** nếu không xử lý lỗi kết nối, Fee Service có thể sập hoặc treo, và mỗi lần gọi ngân hàng tắt phải chờ rất lâu.

**Cách xử lý:**

- Lỗi `ECONNREFUSED` (và các lỗi tương tự như `ENOTFOUND`, `EHOSTUNREACH`) được nhận diện là "request chưa tới ngân hàng".
- Thử lại tối đa 3 lần với khoảng nghỉ ngắn (100ms, 200ms), rồi trả 503 kèm JSON `error`, `paymentId`, `status: FAILED`. Tổng thời gian khoảng 0,4 giây, nằm trong mức 1,5 giây.
- Mọi lỗi được bắt trong code nên Fee Service không sập. API xem công nợ không phụ thuộc ngân hàng nên luôn trả 200 nhanh.
- Mỗi lần gọi đều mở kết nối mới nếu cần, nên khi ngân hàng chạy lại, thanh toán trả 201 mà không cần khởi động lại Fee Service.
- Địa chỉ ngân hàng đọc từ `BANK_URL`, mặc định `http://localhost:4002`.

### 4.4. Tình huống 2 - Ngân hàng phản hồi rất chậm

**Vấn đề:** nếu chờ ngân hàng 5 giây thì sinh viên và tài nguyên của Fee Service bị giữ lâu, nhất là khi nhiều lệnh cùng chờ.

**Cách xử lý:**

- Mỗi thanh toán có **hạn tổng 4 giây**, tính từ lúc bắt đầu gọi (gồm cả các lần thử lại). Quá hạn thì hủy request và trả 504 với `PENDING`. Thực tế đo được khoảng 4,1 giây, nằm trong mức 4,5 giây.
- Vì không biết ngân hàng sẽ trừ tiền hay không sau khi mình bỏ chờ, kết quả là PENDING chứ không phải FAILED.
- Node.js xử lý bất đồng bộ nên 20 thanh toán đang chờ không chặn các request khác. `GET /students/1/fees` vẫn trả trong vài ms.
- Fee Service cộng dồn số tiền của các lệnh đang xử lý (đặt trước) để kiểm tra "không vượt công nợ", tránh nhiều lệnh đồng thời cùng vượt tổng nợ.

### 4.5. Tình huống 3 - Duy trì kết nối

**Vấn đề:** mỗi lời gọi mở một kết nối TCP rồi đóng thì tốn thời gian bắt tay và tài nguyên của hai phía. Ngân hàng lại đóng kết nối nhàn rỗi sau 5 giây.

**Cách xử lý:**

- Dùng `http.Agent` với `keepAlive: true` để tái sử dụng kết nối giữa các request (tối đa 50 socket, giữ rảnh tối đa 10).
- Với 200 thanh toán, 10 yêu cầu cùng lúc, số kết nối TCP mới chỉ khoảng 11, thấp hơn mức 20 cho phép.
- **Vấn đề kết nối cũ bị đóng:** sau khi nhàn rỗi quá 5 giây, ngân hàng đóng kết nối nhưng phía Fee Service có thể vẫn tưởng kết nối còn dùng được, dẫn đến lỗi `ECONNRESET` khi gửi request. Lỗi này được xử lý như "không biết đã tới ngân hàng chưa" và thử lại với cùng `Idempotency-Key`. Lần thử lại dùng kết nối mới nên thành công, và không có nguy cơ trừ tiền hai lần.

### 4.6. Tình huống 4 - Đứt giữa chừng, lỗi tạm thời, bị từ chối

Ba kiểu hỏng được xử lý khác nhau vì bản chất khác nhau:

| Kiểu | Ngân hàng đã trừ tiền chưa? | Cách xử lý |
|---|---|---|
| (a) Đã trừ rồi đứt kết nối | Có, nhưng Fee Service không biết | Thử lại cùng `Idempotency-Key`; ngân hàng trả giao dịch cũ, không trừ thêm |
| (b) Lỗi 500 trước khi trừ | Chưa | Thử lại, lần sau thành công thì trừ đúng một lần |
| (c) Từ chối vì vượt hạn mức (402) | Chưa, và sẽ không bao giờ | **Không thử lại**, trả luôn 402 và `FAILED` |

Chi tiết cách thử lại:

- Tối đa 6 lần, nghỉ 100ms, 200ms, 300ms... giữa các lần, luôn nằm trong hạn tổng 4 giây.
- Chỉ thử lại với: đứt kết nối, hết thời gian của một lần gọi, và lỗi 5xx. Lỗi 4xx (400, 402) là ngân hàng từ chối rõ ràng nên trả về ngay.
- Với tỉ lệ lỗi 0,3 thì xác suất cả 6 lần đều lỗi chỉ khoảng 0,07%, nên 60/60 thanh toán thành công trong lần chạy thử. Yêu cầu của đề là ≥ 54/60.
- Nếu hết số lần thử mà vẫn không chắc, kết quả là 504 + `PENDING`, công nợ không giảm.
- Công nợ chỉ giảm khi nhận 201 từ ngân hàng, nên công nợ luôn giảm đúng bằng tiền của các lệnh `PAID`.

### 4.7. Tại sao đảm bảo được "không trừ tiền hai lần"

Ngân hàng đếm `duplicates` khi có hai lần trừ tiền khác nhau cho cùng một `reference`. Vì mỗi lệnh dùng `paymentId` làm cả `reference` lẫn `Idempotency-Key` và các lần thử lại luôn dùng lại khóa này, ngân hàng nhận ra đó là cùng một giao dịch và trả lại kết quả cũ. Do đó `duplicates` luôn bằng 0.

## 5. Số liệu khi chạy thử (để trình bày)

| Tình huống | Kết quả đo được |
|---|---|
| 1 | Ngân hàng tắt: 503 sau khoảng 0,4 giây. Xem công nợ: 5 ms. Ngân hàng chạy lại: 201 |
| 2 | 504 `PENDING` sau khoảng 4,1 giây. Xem công nợ khi 20 lệnh đang chờ: 4 ms |
| 3 | 200/200 thành công trong khoảng 0,7 giây, 11 kết nối TCP. Sau nhàn rỗi 6 giây, 5/5 yêu cầu thành công |
| 4a | 60/60 thành công, `duplicates` = 0, công nợ giảm đúng 60.000đ |
| 4b | 60/60 thành công, `duplicates` = 0 |
| 4c | 402, ngân hàng nhận đúng 1 yêu cầu |

Số liệu "trước khi sửa" để so sánh: bạn tự đo bằng phiên bản Fee Service gọi ngân hàng không có keep-alive, không có hạn thời gian và không có thử lại, sau đó chạy lại các collection tương ứng.

## 6. API tóm tắt

**Fee Service (4001)**

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/students/{id}/fees` | Xem công nợ. Sinh viên 1: 50.000.000đ, 2: 0, 3: 3.200.000đ |
| POST | `/students/{id}/payments` | Body `{"amount": 100000}`. Kiểm tra số tiền không vượt công nợ |

**Ngân hàng (4002)**

| Method | Đường dẫn | Mô tả |
|---|---|---|
| POST | `/charges` | Body `{"reference","amount"}`, header `Idempotency-Key`. 201 kèm `chargeId`; 400 số tiền không hợp lệ; 402 vượt hạn mức 20.000.000đ |
| GET | `/stats` | `{connections, requests, charges, duplicates}` |

**Biến môi trường của ngân hàng:** `DELAY_MS` (trễ thêm), `FAIL_RATE` (tỉ lệ lỗi 500 trước khi trừ), `DROP_RATE` (tỉ lệ trừ xong rồi cắt kết nối).

**Biến môi trường của Fee Service:** `BANK_URL` (mặc định `http://localhost:4002`).
