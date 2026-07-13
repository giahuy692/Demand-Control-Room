# Ma trận truy vết quy tắc

| Rule | Tài liệu giải pháp | Thành phần dự kiến | Golden test | Trạng thái trước code |
|---|---|---|---|---|
| RULE-01-001 | Chặng 1 | CalendarBuilder | GT-01, GT-02 | Chờ triển khai |
| RULE-01-002 | Chặng 1 | CycleBuilder | GT-03 | Chờ triển khai |
| RULE-01-003 | Chặng 1 | ReferenceWindowService | GT-04 | Chờ triển khai |
| RULE-01-004 | Chặng 1/6 | RunScopeService | GT-15 | Chờ triển khai |
| RULE-02-001 | Chặng 2 | StockoutDetector | GT-05 | Chờ triển khai |
| RULE-02-002 | Chặng 2 | StockoutDetector | GT-02 | Chờ triển khai |
| RULE-02-003 | Chặng 2 | StockQualityService | GT-06 | Chờ triển khai |
| RULE-03-001 | Chặng 3 | ReferenceSelector | GT-07 | Chờ triển khai |
| RULE-03-002 | Chặng 3 | ReferenceSelector | GT-08 | Chờ triển khai |
| RULE-03-003 | Chặng 3 | BaselineFallbackService | GT-13, GT-14 | Chờ triển khai |
| RULE-04-001 | Chặng 4 | PromotionPolicyService | GT-09 | Chờ triển khai |
| RULE-04-002 | Chặng 4 | PromotionRegionBuilder | GT-10 | Chờ triển khai |
| RULE-04-003 | Chặng 4 | PromotionBaselineService | GT-11 | Chờ triển khai |
| RULE-04-004 | Chặng 4 | BaselineExceptionService | GT-12 | Chờ triển khai |
| RULE-05-001 | Chặng 5 | CycleQualityService | GT-16 | Chờ triển khai |
| RULE-05-002 | Chặng 5 | TechnicalFillService | GT-17 | Chờ triển khai |
| RULE-05-003 | Chặng 5 | CycleRepresentativeFill | GT-18, GT-19 | Chờ triển khai |
| RULE-05-004 | Chặng 5 | StatisticsService | GT-18 | Chờ triển khai |
| RULE-05-005 | Chặng 5 | CycleLocker | GT-16–GT-20, GT-31 | Chờ triển khai |
| RULE-05-006 | Cổng 5→6+ | SeriesEligibilityService | GT-31, GT-32, GT-33 | Chờ triển khai |
| RULE-06-001 | Chặng 6 | AbcClassifier | GT-21 | Chờ triển khai |
| RULE-06-002 | Chặng 6/8 | ApprovalService | GT-22 | Chờ triển khai |
| RULE-06-003 | Chặng 6 | AbcInputGate | GT-32, GT-34 | Chờ triển khai |
| RULE-07-001 | Chặng 7 | XyzClassificationGate | GT-23, GT-33, GT-35 | Chờ triển khai |
| RULE-07-002 | Chặng 7 | XyzClassifier | GT-24, GT-32 | Chờ triển khai |
| RULE-07-003 | Chặng 7 | ContinuousWindowBuilder | GT-31, GT-32, GT-33 | Chờ triển khai |
| RULE-07-004 | Chặng 7 | ZeroDemandPolicy | GT-36 | Chờ triển khai |
| RULE-08-001 | Chặng 8 | PolicyVersionService | GT-25 | Chờ triển khai |
| RULE-08-002 | Chặng 8 | PolicyAssignment | GT-26 | Chờ triển khai |
| RULE-11-001 | Chặng 11 | ForecastInputGate | GT-33, GT-37 | Chờ triển khai |
| RULE-12-001 | Chặng 12 | PromoLiftLearner | GT-27 | Chờ triển khai |
| RULE-13-001 | Chặng 13 | FuturePromoApplicator | GT-28 | Chờ triển khai |
| RULE-13-002 | Chặng 13 | StageEvaluationService | GT-29 | Chờ triển khai |

## Quy tắc nghiệm thu

- Không có rule nào thiếu hàm thực thi hoặc test.
- Một test thất bại phải dẫn ngược được về rule.
- Không đóng task nếu traceability vẫn ghi “Chưa có test”.
