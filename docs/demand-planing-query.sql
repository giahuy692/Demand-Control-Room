SELECT TOP 100 *
FROM tbl_SALPoSDetails;

SELECT TOP 100 *
FROM tbl_SALPoSMaster;

SELECT TOP 100 *
FROM tbl_LSProduct

SELECT TOP 100 *
FROM tbl_OPSImExMaster;

SELECT TOP 100 *
FROM tbl_LSDocumentType;

SELECT TOP 100 *
FROM tbl_LSStatus;

SELECT TOP 100 *
FROM tbl_POLPromotion;

SELECT TOP 100 *
FROM tbl_POLBundle;



SELECT
    d.Product,
    m.EffDate,
    m.DocumentType,
    m.DocumentStatus,
    d.Quantity,
    d.QtyReceived
FROM tbl_OPSImExDetails d
INNER JOIN tbl_OPSImExMaster m
    ON d.DocumentNo = m.Code;


SELECT 
    FK.name AS TenKhoaNgoai,
    OBJECT_NAME(FK.parent_object_id) AS BangHienTai,
    COL_NAME(FKC.parent_object_id, FKC.parent_column_id) AS CotTrongBangHienTai,
    OBJECT_NAME(FK.referenced_object_id) AS BangThamChieu,
    COL_NAME(FKC.referenced_object_id, FKC.referenced_column_id) AS CotTrongBangThamChieu
FROM sys.foreign_keys AS FK
INNER JOIN sys.foreign_key_columns AS FKC ON FK.object_id = FKC.constraint_object_id
WHERE OBJECT_NAME(FK.parent_object_id) = 'tbl_POLBundle';