# CHANGELOG — Demand Planning Governance Package v3

## Quyết định chính

1. Thêm cổng chất lượng chuỗi sau Chặng 5 cho ABC, XYZ và dự báo.
2. Không được lọc bỏ CK unresolved rồi nối các CK khóa rải rác.
3. `CycleBaseDemand >= 0` chỉ hợp lệ khi CK đã khóa và không còn ngày unresolved.
4. SKU lâu năm có chuỗi đứt có `DemandClass=null`, không gán D.
5. D chỉ dùng cho SKU mới hoặc lịch sử thật sự ngắn đã xác minh.
6. Phân biệt:
   - phục hồi nền lịch sử;
   - cửa hàng tham chiếu cùng SKU;
   - SKU tương tự do AI đề xuất;
   - kế hoạch MD cho dự báo tương lai.
7. Bổ sung GT-31 đến GT-40 và cập nhật Instruction lên `DP-AI-001 v1.1.0`.

## File thay đổi lớn

- `01-Danh-sach-quyet-dinh-nghiep-vu.md`
- `02-Hop-dong-du-lieu-dau-vao.md`
- `04-Dac-ta-trien-khai-Demand-Planning.md`
- `06-Quy-trinh-phe-duyet-va-xu-ly-ngoai-le.md`
- `07-Danh-muc-Golden-Test.md`
- `08-Dac-ta-bao-cao-mo-phong-va-Audit-Explorer.md`
- `INSTRUCTIONS.md`
- `Tài liệu giải pháp - Demand Planning & Replenishment Governance(26).md`
